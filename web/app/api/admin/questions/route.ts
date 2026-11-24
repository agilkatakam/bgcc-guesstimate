import { q, markStateChanged } from "@/lib/db";
import { load, stateOf } from "@/lib/game";
import { checkPost, json } from "@/lib/http";
import { requireAdmin, log } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Edit one question. Range/note: any time (everyone is rescored). Text and
// timings: only for items that haven't opened yet, so the live schedule never shifts.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const b = (await req.json().catch(() => ({}))) as {
    idx?: number; low?: number; high?: number; answer?: number | null; weight?: number; section?: string; note?: string; text?: string; unit?: string; seconds?: number; reveal_seconds?: number;
  };
  const L = await load();
  const x = L.questions[Number(b.idx)];
  if (!x) return json(req, { ok: false, error: "no such item" }, 404);
  const s = stateOf(L);
  const opened = L.game.mode !== "lobby" && (s.index === null ? true : x.idx <= s.index);

  const changes: Record<string, unknown> = {};
  if (b.low !== undefined || b.high !== undefined) {
    const low = Number(b.low ?? x.low), high = Number(b.high ?? x.high);
    if (x.kind !== "q" || !(low > 0 && high >= low && Number.isFinite(high))) return json(req, { ok: false, error: "Need 0 < low ≤ high" }, 400);
    changes.low = low; changes.high = high;
  }
  if (b.answer !== undefined) {
    // A new answer moves the scored band with it when the band was the exact answer.
    const a = b.answer === null ? null : Number(b.answer);
    if (x.kind !== "q" || (a !== null && !(a > 0 && Number.isFinite(a)))) return json(req, { ok: false, error: "Answer must be a number > 0" }, 400);
    changes.answer = a;
    if (a !== null && b.low === undefined && b.high === undefined && x.low === x.high) { changes.low = a; changes.high = a; }
  }
  if (b.weight !== undefined) {
    const w = Number(b.weight);
    if (x.kind !== "q" || !(w > 0 && w <= 100)) return json(req, { ok: false, error: "Weight must be above 0 (max 100)" }, 400);
    changes.weight = w;
  }
  if (b.section !== undefined) changes.section = String(b.section).slice(0, 40);
  if (b.note !== undefined) changes.note = String(b.note).slice(0, 500);
  for (const k of ["text", "unit", "seconds", "reveal_seconds"] as const) {
    if (b[k] === undefined) continue;
    if (opened) return json(req, { ok: false, error: `Can't change ${k} after the item has opened` }, 400);
    if (k === "seconds" || k === "reveal_seconds") {
      const n = Math.trunc(Number(b[k]));
      if (!(n >= (k === "seconds" ? 5 : 0) && n <= 900)) return json(req, { ok: false, error: `bad ${k}` }, 400);
      changes[k] = n;
    } else changes[k] = String(b[k]).slice(0, 1000);
  }
  const keys = Object.keys(changes);
  if (!keys.length) return json(req, { ok: false, error: "nothing to change" }, 400);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE questions SET ${sets} WHERE idx = $1`, [x.idx, ...keys.map((k) => changes[k])]);
  const rangeChange = "low" in changes || "high" in changes || "weight" in changes;
  await q(`UPDATE game SET version = version + 1${rangeChange ? ", ranges_version = ranges_version + 1" : ""} WHERE id = 1`);
  await log(admin, "edit-question", { idx: x.idx, before: { low: x.low, high: x.high, answer: x.answer, weight: x.weight, text: x.text, seconds: x.seconds }, changes });
  markStateChanged();
  return json(req, { ok: true });
}
