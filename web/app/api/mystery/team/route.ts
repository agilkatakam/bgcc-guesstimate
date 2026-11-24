import { q, tx } from "@/lib/db";
import { checkPost, json, preflight, playerFrom } from "@/lib/http";
import { gate, normaliseCode, newJoinCode, Refuse, ANSWER_KEYS, MAX_ANSWER, IN_PERSON } from "@/lib/mystery";

export const dynamic = "force-dynamic";

type Body = { action?: string; name?: string; code?: string; playerId?: number; draft?: Record<string, unknown> };

const cleanName = (raw: unknown) => String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
const WRONG_JOIN_LIMIT = 8; // wrong join codes per player per minute

export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const g = await gate(await playerFrom(req));
  if (!g.ok) return json(req, { ok: false, error: g.error }, g.status);
  const { m, player } = g;
  const b = (await req.json().catch(() => ({}))) as Body;
  const fail = (error: string, status = 400) => json(req, { ok: false, error }, status);
  const forming = m.stage === "teams";
  const locked = () => fail("Teams are locked now. Ask an organiser for changes.", 409);

  try {
    switch (b.action) {
      case "create": {
        if (!forming) return locked();
        const name = cleanName(b.name);
        if (name.length < 2 || name.length > 30) return fail("Team name: 2 to 30 characters.");
        const out = await tx(async (qq) => {
          // Lock the settings row: creates queue up here, so two at once can't both take the last team slot.
          const [{ max_teams: maxTeams }] = await qq<{ max_teams: number }>(`SELECT max_teams FROM mystery WHERE id = 1 FOR UPDATE`);
          if ((await qq(`SELECT 1 FROM team_members WHERE player_id = $1`, [player.id])).length) throw new Refuse("You're already in a team. Leave it first.");
          if (maxTeams > 0) {
            const [{ n }] = await qq<{ n: number }>(`SELECT count(*)::int AS n FROM teams`);
            if (n >= maxTeams) throw new Refuse(`All ${maxTeams} teams have been made. Join one with its lead's code, or ask an organiser.`, 409);
          }
          if ((await qq(`SELECT 1 FROM teams WHERE lower(name) = lower($1)`, [name])).length) throw new Refuse("That team name is taken.");
          let t: { id: number; join_code: string } | undefined;
          for (let i = 0; i < 8 && !t; i++) {
            [t] = await qq<{ id: number; join_code: string }>(
              `INSERT INTO teams (name, captain_id, join_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, join_code`,
              [name, player.id, newJoinCode()],
            );
          }
          if (!t) throw new Refuse("That team name is taken.");
          const j = await qq(`INSERT INTO team_members (player_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING team_id`, [player.id, t.id]);
          if (!j.length) throw new Refuse("You're already in a team. Leave it first.");
          return t;
        });
        return json(req, { ok: true, teamId: out.id, joinCode: out.join_code });
      }

      case "join": {
        if (!forming) return locked();
        const code = normaliseCode(String(b.code ?? ""));
        if (code.length < 4 || code.length > 8) return fail("Type the team's 5-letter code.");
        const out = await tx(async (qq) => {
          // limit check and the record of a wrong code happen together, with the player's row locked
          await qq(`SELECT id FROM players WHERE id = $1 FOR UPDATE`, [player.id]);
          const [{ n: wrong }] = await qq<{ n: number }>(
            `SELECT count(*)::int AS n FROM join_attempts WHERE player_id = $1 AND NOT ok AND at > now() - interval '60 seconds'`,
            [player.id],
          );
          if (wrong >= WRONG_JOIN_LIMIT) throw new Refuse("Too many wrong codes. Wait a minute and try again.", 429);
          const [t] = await qq<{ id: number; name: string }>(`SELECT id, name FROM teams WHERE join_code = $1 FOR UPDATE`, [code]);
          if (!t) {
            await qq(`INSERT INTO join_attempts (player_id, ok) VALUES ($1, false)`, [player.id]);
            return null;
          }
          if ((await qq(`SELECT 1 FROM team_bans WHERE team_id = $1 AND player_id = $2`, [t.id, player.id])).length) throw new Refuse("The lead removed you from this team. Ask an organiser if that was a mistake.", 403);
          if ((await qq(`SELECT 1 FROM team_members WHERE player_id = $1`, [player.id])).length) throw new Refuse("You're already in a team. Leave it first.");
          const [{ n }] = await qq<{ n: number }>(`SELECT count(*)::int AS n FROM team_members WHERE team_id = $1`, [t.id]);
          if (n >= m.max_team_size) throw new Refuse(`${t.name} is full (${m.max_team_size} people).`);
          const j = await qq(`INSERT INTO team_members (player_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING team_id`, [player.id, t.id]);
          if (!j.length) throw new Refuse("You're already in a team. Leave it first.");
          await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1 AND captain_id IS NULL`, [t.id, player.id]);
          return t;
        });
        if (!out) return fail("No team has that code. Check it with your team lead.");
        return json(req, { ok: true, teamId: out.id, name: out.name });
      }

      case "leave": {
        if (!forming) return locked();
        await tx(async (qq) => {
          const [mine] = await qq<{ team_id: number }>(`SELECT team_id FROM team_members WHERE player_id = $1`, [player.id]);
          if (!mine) throw new Refuse("You're not in a team.");
          await qq(`SELECT id FROM teams WHERE id = $1 FOR UPDATE`, [mine.team_id]);
          await qq(`DELETE FROM team_members WHERE player_id = $1`, [player.id]);
          const [next] = await qq<{ player_id: number }>(`SELECT player_id FROM team_members WHERE team_id = $1 ORDER BY joined_at, player_id LIMIT 1`, [mine.team_id]);
          if (!next) await qq(`DELETE FROM teams WHERE id = $1`, [mine.team_id]);
          else await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1 AND (captain_id = $3 OR captain_id IS NULL)`, [mine.team_id, next.player_id, player.id]);
        });
        return json(req, { ok: true });
      }

      case "remove":
      case "makeLead":
      case "rename": {
        if (!forming) return locked();
        const target = Number(b.playerId);
        await tx(async (qq) => {
          const [t] = await qq<{ id: number; captain_id: number | null }>(
            `SELECT t.id, t.captain_id FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.player_id = $1 FOR UPDATE OF t`,
            [player.id],
          );
          if (!t) throw new Refuse("You're not in a team.");
          if (t.captain_id !== player.id) throw new Refuse("Only the team lead can do that.", 403);
          if (b.action === "rename") {
            const name = cleanName(b.name);
            if (name.length < 2 || name.length > 30) throw new Refuse("Team name: 2 to 30 characters.");
            if ((await qq(`SELECT 1 FROM teams WHERE lower(name) = lower($1) AND id <> $2`, [name, t.id])).length) throw new Refuse("That team name is taken.");
            await qq(`UPDATE teams SET name = $2 WHERE id = $1`, [t.id, name]);
            return;
          }
          if (!Number.isInteger(target) || target === player.id) throw new Refuse(b.action === "remove" ? "Use Leave team instead." : "You're already the lead.");
          const inTeam = await qq(`SELECT 1 FROM team_members WHERE team_id = $1 AND player_id = $2`, [t.id, target]);
          if (!inTeam.length) throw new Refuse("That person isn't in your team.");
          if (b.action === "remove") {
            // Removed for good: they can't rejoin, and the team gets a new code so a passed-on code stops working.
            await qq(`DELETE FROM team_members WHERE team_id = $1 AND player_id = $2`, [t.id, target]);
            await qq(`INSERT INTO team_bans (team_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [t.id, target]);
            for (let i = 0; i < 5; i++) {
              const r = await qq(`UPDATE teams SET join_code = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM teams WHERE join_code = $2) RETURNING id`, [t.id, newJoinCode()]);
              if (r.length) break;
            }
          }
          else await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1`, [t.id, target]);
        });
        return json(req, { ok: true });
      }

      case "draft": {
        // The lead's working answer, shown to the whole team. Saved as they type.
        if (!m.answers_online) return fail(IN_PERSON, 409);
        if (m.stage !== "play") return fail("You can write the answer once the game starts.", 409);
        const draft: Record<string, string> = {};
        for (const k of ANSWER_KEYS) draft[k] = String(b.draft?.[k] ?? "").slice(0, MAX_ANSWER);
        const r = await q(
          `UPDATE teams t SET draft = $1::jsonb, draft_at = now(), draft_by = $2
            WHERE t.id = (SELECT team_id FROM team_members WHERE player_id = $2) AND t.captain_id = $2
              AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.team_id = t.id)
           RETURNING t.id`,
          [JSON.stringify(draft), player.id],
        );
        if (!r.length) return fail("Only the team lead writes the answer, and only before it's submitted.", 403);
        return json(req, { ok: true });
      }

      default:
        return fail("unknown action");
    }
  } catch (e) {
    if (e instanceof Refuse) return fail(e.message, e.status);
    throw e;
  }
}

export const OPTIONS = preflight;
