// The game is a schedule. The current phase is a pure function of the stored
// game row, the ordered item list and the server time (always the DATABASE
// clock in production). Nothing has to "fire" at a deadline.
//
// Per item:  open [opensAt, closesAt)  ->  closing [closesAt, revealAt)  ->  reveal [revealAt, revealEndsAt)
// "closing" is a quiet gap: answers are still accepted for GRACE_MS, and the
// range is never shown until revealAt = closesAt + GAP_MS (> GRACE_MS).

export const GRACE_MS = 2000;
export const GAP_MS = 3000;

export type Item = {
  seconds: number; // answer window
  revealSeconds: number; // reveal shown after the gap
};

export type Game = {
  mode: "lobby" | "running" | "finished";
  anchorAt: number; // ms: when items[anchorIndex] opened
  anchorIndex: number;
  pausedAt: number | null; // frozen schedule clock while paused
  extensions: Record<number, number>; // item index -> extra answer ms
  revealExtensions: Record<number, number>; // item index -> extra reveal ms
  maxRevealedIndex: number; // -1 = none. Items <= this can never accept answers again.
};

export type Phase = "lobby" | "countdown" | "open" | "closing" | "reveal" | "results";

export type State = {
  phase: Phase;
  index: number | null;
  opensAt: number | null;
  closesAt: number | null;
  revealAt: number | null;
  revealEndsAt: number | null;
  nextChangeAt: number | null; // null while paused / nothing scheduled
  paused: boolean;
};

export const newGame = (): Game => ({
  mode: "lobby", anchorAt: 0, anchorIndex: 0, pausedAt: null, extensions: {}, revealExtensions: {}, maxRevealedIndex: -1,
});

const windowMs = (items: Item[], g: Game, i: number) => items[i].seconds * 1000 + (g.extensions[i] ?? 0);
const revealMs = (items: Item[], g: Game, i: number) => items[i].revealSeconds * 1000 + (g.revealExtensions[i] ?? 0);
const slotMs = (items: Item[], g: Game, i: number) => windowMs(items, g, i) + GAP_MS + revealMs(items, g, i);

/** Times of item i, walking forward from the anchor. Null before the anchor or in lobby. */
export function itemTimes(g: Game, items: Item[], i: number) {
  if (g.mode === "lobby" || i < g.anchorIndex || i >= items.length) return null;
  let start = g.anchorAt;
  for (let k = g.anchorIndex; k < i; k++) start += slotMs(items, g, k);
  const closesAt = start + windowMs(items, g, i);
  const revealAt = closesAt + GAP_MS;
  return { opensAt: start, closesAt, revealAt, revealEndsAt: revealAt + revealMs(items, g, i) };
}

export function currentState(g: Game, items: Item[], now: number): State {
  const paused = g.pausedAt !== null;
  const empty = { index: null, opensAt: null, closesAt: null, revealAt: null, revealEndsAt: null, nextChangeAt: null, paused };
  if (g.mode === "lobby") return { phase: "lobby", ...empty };
  if (g.mode === "finished") return { phase: "results", ...empty };
  const t = g.pausedAt ?? now;
  for (let i = g.anchorIndex; i < items.length; i++) {
    const times = itemTimes(g, items, i)!;
    const at = (phase: Phase, next: number): State => ({ phase, index: i, ...times, nextChangeAt: paused ? null : next, paused });
    // Only the first item after Start can lie in the future: "starting in 10…" on every screen.
    if (t < times.opensAt) return at("countdown", times.opensAt);
    if (t < times.closesAt) return at("open", times.closesAt);
    if (t < times.revealAt) return at("closing", times.revealAt);
    if (t < times.revealEndsAt) return at("reveal", times.revealEndsAt);
  }
  return { phase: "results", ...empty };
}

/** Highest item whose range is (or has been) public at `now`. */
export function revealedUpTo(g: Game, items: Item[], now: number): number {
  const s = currentState(g, items, now);
  let r = g.maxRevealedIndex;
  if (s.phase === "reveal" && s.index !== null) r = Math.max(r, s.index);
  // the item before the current one was revealed only if it ran in this anchor run
  if ((s.phase === "open" || s.phase === "closing") && s.index !== null && s.index - 1 >= g.anchorIndex) r = Math.max(r, s.index - 1);
  if (s.phase === "results" && g.mode === "running") r = Math.max(r, items.length - 1);
  return r;
}

// ---- admin transitions. Each first records what has been revealed. ----

const mark = (g: Game, items: Item[], now: number): Game => ({ ...g, maxRevealedIndex: revealedUpTo(g, items, now) });

/** Start the game. The first item opens countdownMs from now; until then every screen counts down. */
export const start = (g: Game, now: number, countdownMs = 0): Game => {
  if (g.mode !== "lobby") throw new Error("already started");
  return { ...newGame(), mode: "running", anchorAt: now + Math.max(0, countdownMs) };
};

export const pause = (g: Game, items: Item[], now: number): Game =>
  g.pausedAt !== null || g.mode !== "running" ? g : { ...mark(g, items, now), pausedAt: now };

export const resume = (g: Game, now: number): Game =>
  g.pausedAt === null ? g : { ...g, anchorAt: g.anchorAt + (now - g.pausedAt), pausedAt: null };

/** Open item k now. Refuses items whose range has been public. */
export const jumpTo = (g: Game, items: Item[], k: number, now: number): Game => {
  if (k < 0 || k >= items.length) throw new Error("bad item");
  const m = mark(g, items, g.pausedAt ?? now);
  if (k <= m.maxRevealedIndex) throw new Error("item already revealed; cannot reopen");
  const ext = { ...m.extensions };
  const rext = { ...m.revealExtensions };
  for (const key of Object.keys(ext)) if (Number(key) >= k) delete ext[Number(key)];
  for (const key of Object.keys(rext)) if (Number(key) >= k) delete rext[Number(key)];
  return { ...m, mode: "running", anchorIndex: k, anchorAt: now, pausedAt: null, extensions: ext, revealExtensions: rext };
};

/** Add answer time to the current OPEN item only. */
export const extend = (g: Game, items: Item[], ms: number, now: number): Game => {
  const s = currentState(g, items, now);
  if (s.phase !== "open" || s.index === null) throw new Error("no open question");
  return { ...mark(g, items, now), extensions: { ...g.extensions, [s.index]: (g.extensions[s.index] ?? 0) + ms } };
};

/** Lengthen the current reveal (e.g. to explain an answer). */
export const extendReveal = (g: Game, items: Item[], ms: number, now: number): Game => {
  const s = currentState(g, items, now);
  if (s.phase !== "reveal" || s.index === null) throw new Error("not in reveal");
  return { ...mark(g, items, now), revealExtensions: { ...g.revealExtensions, [s.index]: (g.revealExtensions[s.index] ?? 0) + ms } };
};

export const finish = (g: Game, items: Item[], now: number): Game => ({ ...mark(g, items, now), mode: "finished", pausedAt: null });

/** Can an answer for item i be saved at `now`? */
export function acceptsAnswer(g: Game, items: Item[], i: number, now: number): boolean {
  if (g.mode !== "running" || i <= g.maxRevealedIndex) return false;
  const times = itemTimes(g, items, i);
  if (!times) return false;
  const t = g.pausedAt ?? now;
  if (t < times.opensAt) return false;
  if (t < times.closesAt) return true;
  return g.pausedAt === null && now - times.closesAt <= GRACE_MS;
}

/** Answer time on the schedule clock (frozen during pauses). */
export function elapsedFor(g: Game, items: Item[], i: number, now: number): number {
  const times = itemTimes(g, items, i);
  if (!times) return 0;
  return Math.max(0, Math.min(g.pausedAt ?? now, times.closesAt) - times.opensAt);
}
