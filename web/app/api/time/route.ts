import { q } from "@/lib/db";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

// Uncached database clock, for countdown offsets.
export async function GET(req: Request) {
  const [r] = await q<{ now: string }>(`SELECT now() AS now`);
  return json(req, { serverNow: new Date(r.now).getTime() });
}

export const OPTIONS = preflight;
