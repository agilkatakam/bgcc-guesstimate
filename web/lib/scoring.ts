// Guesstimate scoring. The rubric is data (game.scoring in the database), so the organisers can
// change it without code: Admin → Scoring rubric, or `node scripts/manage.ts scoring rubric.json`.
//
// A rubric gives the points for: inside the accepted range, within x TIMES of it (steps, checked in
// order), further than every step, and no answer. "Times" means a ratio, not a gap: for the range
// 1000–2000, "within 2x" is 500–4000. Comparisons avoid division so band edges are exact.
//
// lowerWins true (default): points are penalties, lowest total ranks first.
// lowerWins false: points are a score, highest total ranks first.

export type Bands = {
  inside: number;
  steps: [number, number][]; // [x times, points], x ascending
  beyond: number;
  blank: number;
  lowerWins?: boolean;
};

// Points, highest total wins. A question's answer is stored as low = high = the answer, so
// "within 1.1x" means between answer/1.1 and answer*1.1. Each question's weight multiplies
// these (Easy x1, Medium x2, Hard x3 in questions.csv).
export const DEFAULT_BANDS: Bands = {
  inside: 10,
  steps: [[1.1, 10], [1.25, 7], [1.5, 5], [2, 3], [3, 1]],
  beyond: 0,
  blank: 0,
  lowerWins: false,
};

/** The old penalty rubric (lowest wins), kept for reference and tests. */
export const PENALTY_BANDS: Bands = {
  inside: 0,
  steps: [[2, 50], [5, 100], [10, 150]],
  beyond: 200,
  blank: 250,
  lowerWins: true,
};

export const lowerWins = (b: Bands) => b.lowerWins !== false;

export function penalty(value: number | null, low: number, high: number, b: Bands = DEFAULT_BANDS): number {
  if (value === null || !Number.isFinite(value)) return b.blank;
  if (value >= low && value <= high) return b.inside;
  if (value <= 0) return b.beyond;
  for (const [x, p] of b.steps) {
    if (value > high ? value <= x * high : value * x >= low) return p;
  }
  return b.beyond;
}

/** Validate a rubric from the admin panel or a file. Returns an error string or the clean rubric. */
export function parseBands(raw: unknown): Bands | string {
  const o = (typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return "Not valid JSON";
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6;
  if (!num(o.inside) || !num(o.beyond) || !num(o.blank)) return "inside, beyond and blank must be numbers";
  if (!Array.isArray(o.steps) || o.steps.length > 20) return "steps must be a list like [[2, 50], [5, 100]]";
  const steps: [number, number][] = [];
  let prev = 1;
  for (const s of o.steps) {
    if (!Array.isArray(s) || s.length !== 2 || !num(s[0]) || !num(s[1])) return "each step is [times, points]";
    if (!(s[0] > prev)) return "step 'times' must be above 1 and increasing";
    prev = s[0];
    steps.push([s[0], s[1]]);
  }
  if (o.lowerWins !== undefined && typeof o.lowerWins !== "boolean") return "lowerWins must be true or false";
  return { inside: o.inside as number, steps, beyond: o.beyond as number, blank: o.blank as number, lowerWins: o.lowerWins !== false };
}

/** One [label, points] row per band, for the lobby and the admin panel, with a worked example. */
export function describeBands(b: Bands): [string, number][] {
  const ex = (n: number) => Math.round(n).toLocaleString("en-IN");
  const out: [string, number][] = [];
  if (!(b.steps.length && b.steps[0][1] === b.inside)) out.push(["Exactly right", b.inside]);
  for (const [x, p] of b.steps) out.push([`Within ${x}× (${ex(1000 / x)} to ${ex(1000 * x)} if the answer is 1,000)`, p]);
  out.push(["Further off", b.beyond], ["No answer", b.blank]);
  return out;
}

/** Distance from the range's geometric centre in log space. Blank/<=0 -> large finite. */
export const BLANK_CLOSENESS = 1e6;
export const closeness = (value: number | null, low: number, high: number) =>
  value === null || !(value > 0) ? BLANK_CLOSENESS : Math.abs(Math.log(value) - (Math.log(low) + Math.log(high)) / 2);

export type Row = {
  playerId: number;
  total: number;
  blanks: number;
  closenessSum: number; // over all scored questions
  elapsedMs: number; // schedule-clock time of each item's last value change, summed
  createdAt: number;
};

/** Better total, fewer blanks, closer overall, faster, earlier sign-up. Deterministic. */
export const compareRows = (a: Row, b: Row, lower = true) =>
  (lower ? a.total - b.total : b.total - a.total) ||
  a.blanks - b.blanks ||
  a.closenessSum - b.closenessSum ||
  a.elapsedMs - b.elapsedMs ||
  a.createdAt - b.createdAt ||
  a.playerId - b.playerId;
