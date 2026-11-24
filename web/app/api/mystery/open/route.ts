import { checkPost, json, preflight, playerFrom } from "@/lib/http";
import { gate, Refuse } from "@/lib/mystery";
import { openExhibit } from "@/lib/opening";

export const dynamic = "force-dynamic";

// Open an exhibit by tapping it (unlock_mode 'tap'). Adds 1 to the team's count unless already open.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const g = await gate(await playerFrom(req));
  if (!g.ok) return json(req, { ok: false, error: g.error }, g.status);
  const b = (await req.json().catch(() => ({}))) as { n?: unknown };
  const n = Number(b.n);
  if (!Number.isInteger(n) || n < 1 || n > 1000) return json(req, { ok: false, error: "No such exhibit." }, 400);
  try {
    const r = await openExhibit(g.m, g.player, n, false);
    return json(req, { ok: true, n: r.n, title: r.title, already: r.already, count: r.count });
  } catch (e) {
    if (e instanceof Refuse) return json(req, { ok: false, error: e.message }, e.status);
    throw e;
  }
}

export const OPTIONS = preflight;
