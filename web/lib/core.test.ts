import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newGame, currentState, start, pause, resume, jumpTo, extend, extendReveal, finish,
  acceptsAnswer, elapsedFor, revealedUpTo, GAP_MS, type Item,
} from "./schedule.ts";
import { penalty, compareRows, closeness, BLANK_CLOSENESS, parseBands, describeBands, DEFAULT_BANDS, PENALTY_BANDS } from "./scoring.ts";
import { parseAnswer, formatIndian, normaliseEmail, inWords, cleanName } from "./parse.ts";
import * as S from "./schedule.ts";

const items: Item[] = [
  { seconds: 30, revealSeconds: 10 },
  { seconds: 60, revealSeconds: 10 },
  { seconds: 45, revealSeconds: 15 },
];
const T0 = 1_000_000;
const SLOT0 = 30_000 + GAP_MS + 10_000;

test("lobby, start, start-twice refused", () => {
  assert.equal(currentState(newGame(), items, T0).phase, "lobby");
  const g = start(newGame(), T0);
  const s = currentState(g, items, T0 + 5_000);
  assert.deepEqual([s.phase, s.index, s.closesAt], ["open", 0, T0 + 30_000]);
  assert.throws(() => start(g, T0));
});

test("open -> closing gap -> reveal -> next -> results", () => {
  const g = start(newGame(), T0);
  assert.equal(currentState(g, items, T0 + 30_000).phase, "closing");
  assert.equal(currentState(g, items, T0 + 30_000 + GAP_MS).phase, "reveal");
  const s = currentState(g, items, T0 + SLOT0);
  assert.deepEqual([s.phase, s.index], ["open", 1]);
  const total = SLOT0 + (60_000 + GAP_MS + 10_000) + (45_000 + GAP_MS + 15_000);
  assert.equal(currentState(g, items, T0 + total).phase, "results");
});

test("range never public while answers accepted", () => {
  const g = start(newGame(), T0);
  for (let t = 29_000; t < 36_000; t += 100) {
    const s = currentState(g, items, T0 + t);
    if (acceptsAnswer(g, items, 0, T0 + t)) assert.notEqual(s.phase, "reveal", `t=${t}`);
  }
});

test("pause freezes, double pause keeps first, resume shifts", () => {
  let g = start(newGame(), T0);
  g = pause(g, items, T0 + 20_000);
  assert.equal(pause(g, items, T0 + 50_000).pausedAt, T0 + 20_000);
  const frozen = currentState(g, items, T0 + 500_000);
  assert.deepEqual([frozen.phase, frozen.index, frozen.paused, frozen.nextChangeAt], ["open", 0, true, null]);
  assert.equal(acceptsAnswer(g, items, 0, T0 + 900_000), true);
  assert.equal(elapsedFor(g, items, 0, T0 + 900_000), 20_000); // frozen clock
  g = resume(g, T0 + 100_000);
  assert.equal(currentState(g, items, T0 + 100_000).closesAt, T0 + 110_000);
  assert.equal(elapsedFor(g, items, 0, T0 + 105_000), 25_000);
});

test("pause during reveal stays in reveal and marks it revealed", () => {
  let g = pause(start(newGame(), T0), items, T0 + 35_000);
  assert.equal(g.maxRevealedIndex, 0);
  assert.equal(currentState(g, items, T0 + 999_999).phase, "reveal");
});

test("extend: only while open; cannot reopen a revealed item", () => {
  let g = start(newGame(), T0);
  g = extend(g, items, 15_000, T0 + 10_000);
  assert.equal(currentState(g, items, T0 + 40_000).phase, "open");
  assert.throws(() => extend(g, items, 15_000, T0 + 50_000)); // in reveal (window now 45 s)
  const r = extendReveal(g, items, 20_000, T0 + 50_000);
  assert.equal(currentState(r, items, T0 + 45_000 + GAP_MS + 10_000 + 19_000).phase, "reveal");
  assert.equal(currentState(r, items, T0 + 45_000 + GAP_MS + 30_000).index, 1);
});

test("jump: forward ok, back to revealed refused, from pause ok", () => {
  let g = start(newGame(), T0);
  g = jumpTo(g, items, 2, T0 + SLOT0 + 1_000); // item 0 revealed, item 1 open
  assert.equal(g.maxRevealedIndex, 0);
  assert.equal(currentState(g, items, T0 + SLOT0 + 1_000).index, 2);
  assert.equal(acceptsAnswer(g, items, 0, T0 + SLOT0 + 2_000), false);
  assert.throws(() => jumpTo(g, items, 0, T0 + SLOT0 + 2_000));
  assert.doesNotThrow(() => jumpTo(g, items, 1, T0 + SLOT0 + 2_000)); // 1 was open, never revealed
  const p = pause(g, items, T0 + SLOT0 + 5_000);
  const j = jumpTo(p, items, 1, T0 + SLOT0 + 60_000);
  assert.deepEqual([currentState(j, items, T0 + SLOT0 + 60_000).index, j.pausedAt], [1, null]);
  assert.throws(() => jumpTo(g, items, 9, 0));
});

test("finish marks everything reached as revealed", () => {
  const g = start(newGame(), T0);
  assert.equal(revealedUpTo(g, items, T0 + 10 * SLOT0), 2);
  assert.equal(currentState(finish(g, items, T0), items, T0).phase, "results");
});

test("answer acceptance window", () => {
  const g = start(newGame(), T0);
  assert.equal(acceptsAnswer(g, items, 0, T0 + 1), true);
  assert.equal(acceptsAnswer(g, items, 0, T0 + 31_999), true);
  assert.equal(acceptsAnswer(g, items, 0, T0 + 32_001), false);
  assert.equal(acceptsAnswer(g, items, 1, T0 + 1), false);
  assert.equal(acceptsAnswer(newGame(), items, 0, T0), false);
});

test("penalty bands, exact edges", () => {
  const cases: [number | null, number][] = [
    [1500, 0], [1000, 0], [2000, 0], [4000, 50], [4001, 100], [500, 50], [499, 100],
    [10000, 100], [20000, 150], [20001, 200], [100, 150], [99, 200], [0, 200], [null, 250],
  ];
  for (const [v, p] of cases) assert.equal(penalty(v, 1000, 2000, PENALTY_BANDS), p, String(v));
  assert.equal(penalty(5, 5, 5, PENALTY_BANDS), 0);
  assert.equal(penalty(0.3 * 3, 0.1, 0.45, PENALTY_BANDS), 50); // float-safe
});

test("ranking and closeness", () => {
  const base = { playerId: 1, total: 100, blanks: 0, closenessSum: 1, elapsedMs: 5000, createdAt: 1 };
  const rows = [
    { ...base, playerId: 2, total: 150 },
    { ...base, playerId: 3, blanks: 1 },
    { ...base, playerId: 4, elapsedMs: 4000 },
    { ...base, playerId: 6, closenessSum: 0.5, elapsedMs: 9000 },
    { ...base, playerId: 5 },
  ].sort(compareRows);
  assert.deepEqual(rows.map((r) => r.playerId), [6, 4, 5, 3, 2]);
  assert.equal(closeness(null, 1, 100), BLANK_CLOSENESS);
  assert.equal(closeness(0, 1, 100), BLANK_CLOSENESS);
  assert.ok(Math.abs(closeness(10, 1, 100)) < 1e-12);
});

test("parse, format, words", () => {
  assert.equal(parseAnswer("2,50,000"), 250000);
  assert.equal(parseAnswer(" 250000 "), 250000);
  assert.equal(parseAnswer("2500.5"), 2500.5);
  assert.equal(parseAnswer(".5"), 0.5);
  assert.equal(parseAnswer("999999999999999"), 999999999999999);
  for (const bad of ["", "2.5.1", "2e5", "-5", "abc", "25 lakh", "99999999999999999999"]) assert.equal(parseAnswer(bad), null, bad);
  assert.equal(formatIndian(2500000), "25,00,000");
  assert.equal(formatIndian(1234567.25), "12,34,567.25");
  assert.equal(inWords(250000), "2.5 lakh");
  assert.equal(inWords(250000000), "25 crore");
  assert.equal(inWords(4200), "4.2 thousand");
  assert.equal(inWords(42), "42");
});

test("email check", () => {
  assert.equal(normaliseEmail(" F20250123@Goa.Bits-Pilani.ac.in "), "f20250123@goa.bits-pilani.ac.in");
  assert.equal(normaliseEmail("f2025012@goa.bits-pilani.ac.in"), null);
  assert.equal(normaliseEmail("f20250123@gmail.com"), null);
});

test("rubric: custom bands, validation, highest-wins ordering", () => {
  const b = parseBands('{"inside": 10, "steps": [[1.5, 7], [3, 3]], "beyond": 0, "blank": 0, "lowerWins": false}');
  assert.ok(typeof b !== "string");
  if (typeof b === "string") return;
  assert.equal(penalty(1500, 1000, 2000, b), 10);
  assert.equal(penalty(3000, 1000, 2000, b), 7);
  assert.equal(penalty(3001, 1000, 2000, b), 3);
  assert.equal(penalty(6001, 1000, 2000, b), 0);
  assert.equal(penalty(null, 1000, 2000, b), 0);
  assert.equal(describeBands(PENALTY_BANDS).length, 6);
});

test("default rubric: points around an exact answer", () => {
  const b = DEFAULT_BANDS;
  const A = 1600;
  assert.equal(penalty(1600, A, A, b), 10);
  assert.equal(penalty(1760, A, A, b), 10); // 1.1x
  assert.equal(penalty(1761, A, A, b), 7);
  assert.equal(penalty(A / 1.1, A, A, b), 10);
  assert.equal(penalty(1280, A, A, b), 7); // 1.25x below
  assert.equal(penalty(1279, A, A, b), 5);
  assert.equal(penalty(2400, A, A, b), 5);
  assert.equal(penalty(3200, A, A, b), 3);
  assert.equal(penalty(800, A, A, b), 3);
  assert.equal(penalty(4800, A, A, b), 1);
  assert.equal(penalty(4801, A, A, b), 0);
  assert.equal(penalty(0, A, A, b), 0);
  assert.equal(penalty(null, A, A, b), 0);
  assert.equal(penalty(5.5 * 1.1, 5.5, 5.5, b), 10); // decimals: 6.05 km
  assert.equal(penalty(3.4, 3.4, 3.4, b), 10);
  // "exact" row is folded into the first step, so: 5 steps + further + blank
  assert.equal(describeBands(b).length, 7);
  assert.equal(b.lowerWins, false);
  for (const bad of ["nope", '{"inside":0,"steps":[[0.5,1]],"beyond":1,"blank":1}', '{"inside":0,"steps":[[3,1],[2,1]],"beyond":1,"blank":1}', '{"inside":"0","steps":[],"beyond":1,"blank":1}'])
    assert.equal(typeof parseBands(bad), "string", bad);
  const base = { playerId: 1, total: 100, blanks: 0, closenessSum: 1, elapsedMs: 5000, createdAt: 1 };
  const rows = [{ ...base, playerId: 2, total: 150 }, { ...base, playerId: 3, total: 50 }].sort((x, y) => compareRows(x, y, false));
  assert.deepEqual(rows.map((r) => r.playerId), [2, 3]);
});

test("login accepts a bare BITS ID", () => {
  assert.equal(normaliseEmail("f20260123"), "f20260123@goa.bits-pilani.ac.in");
  assert.equal(normaliseEmail(" F2026 0123 "), "f20260123@goa.bits-pilani.ac.in");
  assert.equal(normaliseEmail("f2026012"), null);
  assert.equal(normaliseEmail("20260123"), null);
});

test("countdown before the first item", () => {
  const items = [{ seconds: 10, revealSeconds: 5 }, { seconds: 10, revealSeconds: 5 }];
  const g = S.start(S.newGame(), 1000, 10_000);
  let st = S.currentState(g, items, 5000);
  assert.equal(st.phase, "countdown");
  assert.equal(st.index, 0);
  assert.equal(st.nextChangeAt, 11_000);
  assert.equal(S.acceptsAnswer(g, items, 0, 5000), false);
  st = S.currentState(g, items, 11_000);
  assert.equal(st.phase, "open");
  assert.equal(S.acceptsAnswer(g, items, 0, 11_000), true);
  // pausing during the countdown freezes it; resuming shifts it
  const p = S.pause(g, items, 6000);
  assert.equal(S.currentState(p, items, 60_000).phase, "countdown");
  const r = S.resume(p, 60_000);
  assert.equal(S.currentState(r, items, 64_999).phase, "countdown");
  assert.equal(S.currentState(r, items, 65_000).phase, "open");
  assert.equal(S.revealedUpTo(g, items, 5000), -1);
  // a plain start (no countdown) opens at once
  assert.equal(S.currentState(S.start(S.newGame(), 1000), items, 1000).phase, "open");
});

test("player names", () => {
  assert.equal(cleanName("  Asha   Rao "), "Asha Rao");
  assert.equal(cleanName("Zoë D'Souza-Pai"), "Zoë D'Souza-Pai");
  assert.equal(cleanName("अमित शर्मा"), "अमित शर्मा");
  assert.equal(cleanName("A"), null);
  assert.equal(cleanName("1234"), null);
  assert.equal(cleanName("<script>x</script>"), null);
  assert.equal(cleanName("x".repeat(41)), null);
  assert.equal(cleanName("Bo‮B"), "BoB");
});
