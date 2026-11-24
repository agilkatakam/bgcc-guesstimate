import "server-only";
import { tx } from "./db";
import { Refuse, type MysteryRow } from "./mystery";
import type { Player } from "./http";

/**
 * Open exhibit n for the player's team. One transaction with the team row locked, so an open
 * can never land after the team's submission, and the count a submission records is exact.
 * byCode: the team typed an organiser's code (any member may); otherwise a tap (open_by rule applies).
 */
export async function openExhibit(m: MysteryRow, player: Player, n: number, byCode: boolean) {
  if (m.stage !== "play") throw new Refuse(m.stage === "ended" ? "The game is over." : "Exhibits open when the game starts.", 409);
  return tx(async (qq) => {
    // Re-check the stage under a shared lock: ending the game waits for opens in progress, and no open lands after it.
    const [st] = await qq<{ stage: string }>(`SELECT stage FROM mystery WHERE id = 1 FOR SHARE`);
    if (st?.stage !== "play") throw new Refuse(st?.stage === "ended" ? "The game is over." : "Exhibits open when the game starts.", 409);
    const [t] = await qq<{ id: number; captain_id: number | null }>(
      `SELECT t.id, t.captain_id FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.player_id = $1 FOR UPDATE OF t`,
      [player.id],
    );
    if (!t) throw new Refuse("Join a team first.", 409);
    if (!byCode && m.unlock_mode !== "tap") throw new Refuse("Ask an organiser for this exhibit's code.", 409);
    // In tap mode with "lead only", a code doesn't get around the rule either (codes are a lost-slip fallback there).
    if ((!byCode || m.unlock_mode === "tap") && m.open_by === "lead" && t.captain_id !== player.id) throw new Refuse("Only your team lead can open exhibits.", 403);
    if ((await qq(`SELECT 1 FROM submissions WHERE team_id = $1`, [t.id])).length) throw new Refuse(m.answers_online ? "Your team has submitted, so no more exhibits can be opened." : "Your team has given its answer, so no more exhibits can be opened.", 409);
    const [c] = await qq<{ n: number; title: string }>(`SELECT n, title FROM clues WHERE n = $1`, [n]);
    if (!c) throw new Refuse("No such exhibit.", 404);
    const added = await qq(`INSERT INTO unlocks (team_id, clue_n, player_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING clue_n`, [t.id, n, player.id]);
    const [{ count }] = await qq<{ count: number }>(`SELECT count(*)::int AS count FROM unlocks WHERE team_id = $1`, [t.id]);
    return { n: c.n, title: c.title, already: !added.length, count, teamId: t.id };
  });
}
