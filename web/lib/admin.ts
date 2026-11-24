import "server-only";
import { q } from "./db";
import { adminFrom, json } from "./http";

/** Returns the admin name, or a 401 Response. */
export async function requireAdmin(req: Request): Promise<string | Response> {
  const a = await adminFrom(req);
  return a ?? json(req, { ok: false, error: "admin login required" }, 401);
}

export const log = (admin: string, action: string, detail: unknown, oldGame?: unknown) =>
  q(`INSERT INTO admin_log (admin, action, detail, old_game) VALUES ($1, $2, $3, $4)`, [
    admin, action, JSON.stringify(detail ?? null), oldGame === undefined ? null : JSON.stringify(oldGame),
  ]);
