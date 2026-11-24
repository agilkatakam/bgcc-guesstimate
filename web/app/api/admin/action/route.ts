import { q, markStateChanged } from "@/lib/db";
import { load, gameToRow } from "@/lib/game";
import * as S from "@/lib/schedule";
import { checkPost, json } from "@/lib/http";
import { requireAdmin, log } from "@/lib/admin";
import { parseBands } from "@/lib/scoring";

export const dynamic = "force-dynamic";

type Body = { action?: string; version?: number; item?: number; seconds?: number; confirm?: string; qualifyCount?: number; scoring?: unknown; countdown?: number; note?: string };

export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const b = (await req.json().catch(() => ({}))) as Body;
  const L = await load();
  if (b.version !== L.version) return json(req, { ok: false, error: "Someone else just changed the game. Refreshed; check and try again." }, 409);

  const now = L.now;
  let next: S.Game;
  try {
    switch (b.action) {
      case "start":
        if (b.confirm !== "START") throw new Error("Type START to confirm");
        // Every phone shows "Starting in N" first (default 10 s, so phones that check every few seconds all see it).
        next = S.start(L.game, now, Math.max(0, Math.min(60, Math.trunc(Number(b.countdown ?? 10)) || 0)) * 1000);
        break;
      case "pause":
        next = S.pause(L.game, L.items, now);
        break;
      case "resume":
        next = S.resume(L.game, now);
        break;
      case "jump":
        if (b.confirm !== String(b.item)) throw new Error("Type the item number to confirm");
        next = S.jumpTo(L.game, L.items, Number(b.item), now);
        break;
      case "extend":
        next = S.extend(L.game, L.items, Math.max(1, Math.min(300, Number(b.seconds))) * 1000, now);
        break;
      case "extendReveal":
        next = S.extendReveal(L.game, L.items, Math.max(1, Math.min(600, Number(b.seconds))) * 1000, now);
        break;
      case "finish":
        if (b.confirm !== "FINISH") throw new Error("Type FINISH to confirm");
        next = S.finish(L.game, L.items, now);
        break;
      case "qualify": {
        // 0 = not decided yet. Set on the spot from Admin → Qualifiers.
        const n = Math.trunc(Number(b.qualifyCount));
        if (!(n >= 0 && n <= 5000)) throw new Error("Qualify count must be 0 to 5000");
        await q(`UPDATE game SET qualify_count = $1, version = version + 1 WHERE id = 1 AND version = $2`, [n, L.version]);
        await log(admin, "qualify", { n });
        markStateChanged();
  return json(req, { ok: true });
      }
      case "announce": {
        // Flip every phone and the projector to "You're through" / the cut line (or hide it again).
        const on = b.confirm === "ANNOUNCE";
        if (on && L.qualifyCount <= 0) throw new Error("Pick the top N first (Send top N to Round 2)");
        await q(`UPDATE game SET qualify_announced = $1, version = version + 1 WHERE id = 1 AND version = $2`, [on, L.version]);
        await log(admin, "announce", { on, n: L.qualifyCount });
        markStateChanged();
        return json(req, { ok: true });
      }
      case "lobbyNote": {
        // Shown on the lobby of every phone and the projector, e.g. "Starts around 5:10 to 5:15 PM".
        const note = String(b.note ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
        await q(`UPDATE game SET lobby_note = $1, version = version + 1 WHERE id = 1 AND version = $2`, [note, L.version]);
        await log(admin, "lobbyNote", { note });
        markStateChanged();
  return json(req, { ok: true });
      }
      case "scoring": {
        // Changing the rubric rescores everyone (new ranges_version = new ranking).
        const parsed = b.scoring === null ? null : parseBands(b.scoring);
        if (typeof parsed === "string") throw new Error(`Rubric: ${parsed}`);
        await q(`UPDATE game SET scoring = $1::jsonb, ranges_version = ranges_version + 1, version = version + 1 WHERE id = 1 AND version = $2`,
          [parsed === null ? null : JSON.stringify(parsed), L.version]);
        await log(admin, "scoring", parsed);
        markStateChanged();
  return json(req, { ok: true });
      }
      case "reset": {
        if (b.confirm !== "RESET EVERYTHING") throw new Error("Type RESET EVERYTHING to confirm");
        await log(admin, "reset", null, L.game);
        await q(`DELETE FROM answers`);
        await q(`DELETE FROM rank_snapshot`);
        await q(`UPDATE game SET qualify_count = 0, qualify_announced = false WHERE id = 1`);
        next = S.newGame();
        break;
      }
      default:
        throw new Error("unknown action");
    }
  } catch (e) {
    return json(req, { ok: false, error: (e as Error).message }, 400);
  }

  const r = gameToRow(next);
  const updated = await q(
    `UPDATE game SET mode = $1, anchor_at = $2, anchor_index = $3, paused_at = $4, extensions = $5::jsonb,
                     reveal_extensions = $6::jsonb, max_revealed_index = $7, version = version + 1
      WHERE id = 1 AND version = $8 RETURNING version`,
    [r.mode, r.anchor_at, r.anchor_index, r.paused_at, r.extensions, r.reveal_extensions, r.max_revealed_index, L.version],
  );
  if (!updated.length) return json(req, { ok: false, error: "Someone else just changed the game. Try again." }, 409);
  if (b.action !== "reset") await log(admin, b.action!, { item: b.item, seconds: b.seconds }, L.game);
  markStateChanged();
  return json(req, { ok: true, version: (updated[0] as { version: number }).version });
}
