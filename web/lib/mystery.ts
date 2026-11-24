import "server-only";
import { randomInt } from "node:crypto";
import { q } from "./db";
import type { Player } from "./http";

// Round 2: the mystery. No auction. Teams (one lead each) form with a join code,
// read the case file, open any of the exhibits they want (by default with a code an organiser
// hands them), and give one answer: in person to the organisers (default), or on the website.
// Every different exhibit a team opens counts. Of the correct answers, the team
// that opened the fewest wins; a tie goes to the earlier submission.

export type Stage = "closed" | "teams" | "play" | "ended";

export type MysteryRow = {
  stage: Stage;
  submissions_open: boolean;
  max_team_size: number;
  unlock_mode: "tap" | "code";
  open_by: "lead" | "anyone";
  results_public: boolean;
  /** false: teams tell the organisers their answer in person; an organiser records the moment ("Answer given"). */
  answers_online: boolean;
  /** Most teams players may create themselves (0 = no limit). Organisers' own tools ignore it. */
  max_teams: number;
  version: number;
};

export const loadMystery = async () =>
  (await q<MysteryRow>(`SELECT stage, submissions_open, max_team_size, unlock_mode, open_by, results_public, answers_online, max_teams, version FROM mystery WHERE id = 1`))[0];

/** May this player take part? An empty roster lets every logged-in player in. */
export async function onRoster(email: string): Promise<boolean> {
  const [r] = await q<{ ok: boolean }>(
    `SELECT (NOT EXISTS (SELECT 1 FROM roster) OR EXISTS (SELECT 1 FROM roster WHERE email = $1)) AS ok`,
    [email],
  );
  return r.ok;
}

export async function teamOf(playerId: number): Promise<number | null> {
  const [r] = await q<{ team_id: number }>(`SELECT team_id FROM team_members WHERE player_id = $1`, [playerId]);
  return r?.team_id ?? null;
}

export type TeamView = {
  id: number;
  name: string;
  leadId: number | null;
  joinCode: string | null;
  members: { id: number; name: string; email: string }[];
  draft: Record<string, string>;
  draftAt: string | null;
  draftBy: string | null;
};

export async function teamView(teamId: number): Promise<TeamView | null> {
  const [t] = await q<{ id: number; name: string; captain_id: number | null; join_code: string | null; draft: Record<string, string>; draft_at: string | null; draft_by: string | null }>(
    `SELECT t.id, t.name, t.captain_id, t.join_code, t.draft, t.draft_at, coalesce(p.name, split_part(p.email, '@', 1)) AS draft_by
       FROM teams t LEFT JOIN players p ON p.id = t.draft_by WHERE t.id = $1`,
    [teamId],
  );
  if (!t) return null;
  const members = await q<{ id: number; name: string | null; email: string }>(
    `SELECT p.id, p.name, p.email FROM team_members m JOIN players p ON p.id = m.player_id WHERE m.team_id = $1 ORDER BY m.joined_at, p.id`,
    [teamId],
  );
  return {
    id: t.id,
    name: t.name,
    leadId: t.captain_id,
    joinCode: t.join_code,
    members: members.map((m) => ({ id: m.id, email: m.email, name: m.name ?? m.email.split("@")[0] })),
    draft: t.draft ?? {},
    draftAt: t.draft_at,
    draftBy: t.draft_by,
  };
}

/** The three questions in the case file ("Your answer"). */
export const ANSWER_KEYS = ["q1", "q2", "q3"] as const;
export const MAX_ANSWER = 2000;

/** Codes are typed on phones: ignore case, spaces and dashes. */
export const normaliseCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const newJoinCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

/** Refusal for the website answer flow when answers are given in person. */
export const IN_PERSON = "Answers are given in person: tell an organiser your team's answer.";

/** An expected refusal inside a transaction: rolls back and becomes {ok:false,error} with this status. */
export class Refuse extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type PlayerGate =
  | { ok: true; m: MysteryRow; player: Player }
  | { ok: false; status: number; error: string };

/** The mystery must be open and the player on the roster. */
export async function gate(player: Player | null): Promise<PlayerGate> {
  if (!player) return { ok: false, status: 401, error: "login" };
  if (player.disqualified) return { ok: false, status: 403, error: "This account has been disqualified. Ask an organiser." };
  const m = await loadMystery();
  if (m.stage === "closed") return { ok: false, status: 409, error: "Round 2 hasn't opened yet." };
  if (!(await onRoster(player.email))) return { ok: false, status: 403, error: "Round 2 is for qualifiers only." };
  return { ok: true, m, player };
}

// ---- answer key structure: which exhibit groups each claim needs (parsed from answer-key.md) ----

export type KeyInfo = { groups: Record<string, number[]>; needs: Record<number, string[]>; claims: string[] };

export function parseKey(body: string): KeyInfo {
  const groups: Record<string, number[]> = {};
  // "A = 1, 4, 8; B = 3, 5, 7; ..."
  for (const m of body.matchAll(/\b([A-Z]) = (\d+(?:, \d+)*)/g)) groups[m[1]] = m[2].split(", ").map(Number);
  const needs: Record<number, string[]> = {};
  // "| 1 | A and B |"
  for (const m of body.matchAll(/^\|\s*(\d+)\s*\|\s*([A-Z](?:(?:,| and)\s*[A-Z])*)\s*\|/gm)) needs[Number(m[1])] = m[2].split(/,|and/).map((s) => s.trim()).filter(Boolean);
  const claims = body.split("\n").map((l) => l.match(/^\s*\d+\.\s+(.*)$/)?.[1]).filter((x): x is string => !!x);
  return { groups, needs, claims };
}

// ---- standings ----

export type Standing = {
  teamId: number;
  name: string;
  submittedAt: string;
  opened: number;
  verdict: "correct" | "wrong" | null;
  claims: number;
  rank: number;
};

/**
 * Correct answers first: fewest exhibits opened, then earliest. Then the rest: most claims ticked,
 * fewest opened, earliest. Final only when every submission is judged.
 */
export async function standings(): Promise<{ rows: Standing[]; allJudged: boolean }> {
  const rows = await q<{ team_id: number; name: string; submitted_at: string; opened: number | null; verdict: "correct" | "wrong" | null; claims: number[] | null }>(
    `SELECT s.team_id, t.name, s.submitted_at, s.opened, s.verdict, s.claims FROM submissions s JOIN teams t ON t.id = s.team_id`,
  );
  const list = rows.map((r) => ({
    teamId: r.team_id, name: r.name, submittedAt: r.submitted_at, opened: r.opened ?? 0, verdict: r.verdict,
    claims: Array.isArray(r.claims) ? r.claims.length : 0, rank: 0,
  }));
  const t = (s: string) => new Date(s).getTime();
  list.sort((a, b) => {
    const ca = a.verdict === "correct" ? 0 : 1, cb = b.verdict === "correct" ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (ca === 0) return a.opened - b.opened || t(a.submittedAt) - t(b.submittedAt) || a.teamId - b.teamId;
    return b.claims - a.claims || a.opened - b.opened || t(a.submittedAt) - t(b.submittedAt) || a.teamId - b.teamId;
  });
  list.forEach((r, i) => (r.rank = i + 1));
  return { rows: list, allJudged: list.every((r) => r.verdict !== null) };
}
