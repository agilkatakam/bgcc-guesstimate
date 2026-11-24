import { q } from "@/lib/db";
import { load, stateOf } from "@/lib/game";
import { acceptsAnswer, elapsedFor } from "@/lib/schedule";
import { parseAnswer } from "@/lib/parse";
import { checkPost, json, preflight, playerFrom } from "@/lib/http";

export const dynamic = "force-dynamic";

// Save (or update) a player's answer. Idempotent: keyed by (player, item) and
// only applied if seq is newer than what is stored. Never returns a penalty.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad, retry: false }, 400);
  const player = await playerFrom(req);
  if (!player) return json(req, { ok: false, error: "login", retry: false }, 401);

  const body = (await req.json().catch(() => ({}))) as { item?: unknown; value?: unknown; seq?: unknown };
  const item = Number(body.item);
  const seq = Number(body.seq);
  const value = parseAnswer(String(body.value ?? ""));
  if (!Number.isInteger(item) || !Number.isSafeInteger(seq) || seq < 0)
    return json(req, { ok: false, error: "bad request", retry: false }, 400);
  if (value === null) return json(req, { ok: false, error: "numbers only (max 15 digits)", retry: false }, 400);

  const L = await load();
  const s = stateOf(L);
  const meta = { closesAt: s.closesAt, version: L.version, paused: s.paused, serverNow: L.now };
  const x = L.questions[item];
  if (!x || x.kind !== "q" || !acceptsAnswer(L.game, L.items, item, L.now))
    return json(req, { ok: false, error: "closed", retry: false, ...meta }, 409);

  const elapsed = elapsedFor(L.game, L.items, item, L.now);
  const rows = await q<{ seq: string; value: number }>(
    `INSERT INTO answers (player_id, idx, value, seq, elapsed_ms) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (player_id, idx) DO UPDATE
        SET value = excluded.value,
            seq = excluded.seq,
            elapsed_ms = CASE WHEN answers.value = excluded.value THEN answers.elapsed_ms ELSE excluded.elapsed_ms END,
            updated_at = now()
      WHERE excluded.seq > answers.seq
     RETURNING seq, value`,
    [player.id, item, value, seq, elapsed],
  );
  // A stale seq changes nothing: report what is stored so the client converges.
  const saved = rows[0] ?? (await q<{ seq: string; value: number }>(`SELECT seq, value FROM answers WHERE player_id = $1 AND idx = $2`, [player.id, item]))[0];
  return json(req, { ok: true, item, seq: Number(saved.seq), value: Number(saved.value), ...meta });
}

export const OPTIONS = preflight;
