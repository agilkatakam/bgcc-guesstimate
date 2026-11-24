import { q } from "@/lib/db";
import { json, preflight, playerFrom } from "@/lib/http";
import { gate } from "@/lib/mystery";

export const dynamic = "force-dynamic";

// The case file (public to every mystery player once teams are forming).
export async function GET(req: Request) {
  const g = await gate(await playerFrom(req));
  if (!g.ok) return json(req, { ok: false, error: g.error }, g.status);
  const [d] = await q<{ body: string }>(`SELECT body FROM mystery_docs WHERE key = 'case'`);
  return json(req, { ok: true, body: d?.body ?? "The case file hasn't been loaded yet." });
}

export const OPTIONS = preflight;
