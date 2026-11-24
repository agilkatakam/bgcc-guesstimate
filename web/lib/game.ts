import "server-only";
import { q, stateChangedAt } from "./db";
import { currentState, revealedUpTo, type Game, type Item, type State } from "./schedule";
import { DEFAULT_BANDS, parseBands, penalty, type Bands } from "./scoring";

export type Question = {
  idx: number;
  kind: "q" | "break";
  practice: boolean;
  text: string;
  unit: string;
  low: number | null;
  high: number | null;
  seconds: number;
  reveal_seconds: number;
  note: string;
  section: string;
  weight: number;
  answer: number | null;
};

export type Loaded = {
  now: number; // database clock, ms
  game: Game;
  version: number;
  rangesVersion: number;
  qualifyCount: number; // 0 = not decided yet
  lobbyNote: string;
  qualifyAnnounced: boolean;
  scoring: Bands;
  questions: Question[];
  items: Item[];
};

const ms = (v: unknown) => (v == null ? null : new Date(v as string).getTime());

/** Game row, all questions and the DB clock in ONE round trip. */
export async function load(): Promise<Loaded> {
  const [row] = await q<{ g: Record<string, unknown>; qs: Question[] | null; now: string }>(
    `SELECT row_to_json(g) AS g,
            (SELECT json_agg(x ORDER BY x.idx) FROM questions x) AS qs,
            now() AS now
       FROM game g WHERE id = 1`,
  );
  const g = row.g;
  const questions = (row.qs ?? []).map((x) => ({
    ...x,
    low: x.low == null ? null : Number(x.low),
    high: x.high == null ? null : Number(x.high),
    section: x.section ?? "",
    weight: x.weight == null ? 1 : Number(x.weight),
    answer: x.answer == null ? null : Number(x.answer),
  }));
  const game: Game = {
    mode: g.mode as Game["mode"],
    anchorAt: ms(g.anchor_at) ?? 0,
    anchorIndex: g.anchor_index as number,
    pausedAt: ms(g.paused_at),
    extensions: g.extensions as Record<number, number>,
    revealExtensions: g.reveal_extensions as Record<number, number>,
    maxRevealedIndex: g.max_revealed_index as number,
  };
  return {
    now: new Date(row.now).getTime(),
    game,
    version: g.version as number,
    rangesVersion: g.ranges_version as number,
    qualifyCount: g.qualify_count as number,
    lobbyNote: (g.lobby_note as string | undefined) ?? "",
    qualifyAnnounced: g.qualify_announced === true,
    scoring: bandsFrom(g.scoring),
    questions,
    items: questions.map((x) => ({ seconds: x.seconds, revealSeconds: x.reveal_seconds })),
  };
}

/**
 * load() shared for up to 250 ms by read-only player routes (/api/me, /api/leaderboard), so 1,000 phones
 * refreshing at a reveal cost a handful of game reads, not 1,000. Never used for saving answers or admin
 * actions. `now` is advanced by the age of the copy, and any admin change drops it at once.
 */
let shared: { at: number; v: Loaded } | null = null;
let sharedLoading: { at: number; p: Promise<Loaded> } | null = null;
export async function loadShared(): Promise<Loaded> {
  const t = Date.now();
  const changed = stateChangedAt();
  if (shared && t - shared.at < 250 && changed < shared.at) return { ...shared.v, now: shared.v.now + (t - shared.at) };
  if (!sharedLoading || changed >= sharedLoading.at) {
    const at = Date.now();
    sharedLoading = { at, p: load().then((v) => { shared = { at, v }; return v; }).finally(() => { if (sharedLoading?.at === at) sharedLoading = null; }) };
  }
  const v = await sharedLoading.p;
  return { ...v, now: v.now + (Date.now() - t) };
}

const bandsFrom = (raw: unknown): Bands => {
  if (raw == null) return DEFAULT_BANDS;
  const b = parseBands(raw);
  return typeof b === "string" ? DEFAULT_BANDS : b;
};

/** The cut-off as players see it: 0 until the organisers announce it. */
export const publicQualify = (L: Loaded) => (L.qualifyAnnounced ? L.qualifyCount : 0);

/** Ranks and the leaderboard stay hidden until the guesstimate is over. */
export const ranksPublic = (L: Loaded) => stateOf(L).phase === "results";

export const stateOf = (L: Loaded): State => currentState(L.game, L.items, L.now);

export const keyOf = (L: Loaded, s: State) => `${L.version}-${s.index ?? "x"}-${s.phase}${s.paused ? "-p" : ""}`;

/** Highest scored item whose range is public, used for scores and rank snapshots. */
export const revealedThrough = (L: Loaded) => revealedUpTo(L.game, L.items, L.now);

/** Scored question number (1-based) and how many there are. n is null for practice items and breaks. */
export function numbering(qs: Question[], idx: number): { n: number | null; total: number } {
  const total = qs.filter((y) => y.kind === "q" && !y.practice).length;
  const x = qs[idx];
  if (!x || x.kind !== "q" || x.practice) return { n: null, total };
  return { n: qs.slice(0, idx + 1).filter((y) => y.kind === "q" && !y.practice).length, total };
}

/** Position label for players: practice items aren't numbered, breaks aren't counted. */
export function labelFor(qs: Question[], idx: number): string {
  const x = qs[idx];
  if (!x) return "";
  if (x.kind === "break") return "Break";
  if (x.practice) return `Practice ${qs.slice(0, idx + 1).filter((y) => y.kind === "q" && y.practice).length}`;
  const { n, total } = numbering(qs, idx);
  return `${x.section ? `${x.section} · ` : ""}Q${n} of ${total}`;
}

/** Points (or penalty) for one answer: the rubric's band times the question's weight. */
export const pointsFor = (x: Question, value: number | null, b: Bands): number =>
  Math.round(penalty(value, x.low!, x.high!, b) * (x.weight || 1) * 100) / 100;

export function gameToRow(g: Game) {
  return {
    mode: g.mode,
    anchor_at: g.anchorAt ? new Date(g.anchorAt).toISOString() : null,
    anchor_index: g.anchorIndex,
    paused_at: g.pausedAt == null ? null : new Date(g.pausedAt).toISOString(),
    extensions: JSON.stringify(g.extensions),
    reveal_extensions: JSON.stringify(g.revealExtensions),
    max_revealed_index: g.maxRevealedIndex,
  };
}
