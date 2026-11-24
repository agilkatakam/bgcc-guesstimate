import { q } from "@/lib/db";
import { checkPost, json, verifySecret, newToken, sha256, cookie, isSecure, clientIp } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const ip = clientIp(req);
  const body = (await req.json().catch(() => ({}))) as { name?: string; password?: string };
  const name = String(body.name ?? "").slice(0, 100);
  // Every attempt is recorded first, then counted (so a burst in parallel can't all slip under the limit).
  // Over the limit (10 per address, 20 per admin name, in 10 minutes) a WRONG password is refused without
  // telling whether it was right; a RIGHT one still gets in. Admin passwords are 10+ characters, so that
  // gives a guesser nothing, and a student spamming bad logins on the shared campus address can't lock
  // the organisers out.
  const [{ id: attempt }] = await q<{ id: string }>(`INSERT INTO admin_attempts (ip, name) VALUES ($1, $2) RETURNING ctid::text AS id`, [ip, name]);
  const [{ n, byName }] = await q<{ n: number; byName: number }>(
    `SELECT count(*) FILTER (WHERE ip = $1)::int AS n, count(*) FILTER (WHERE name = $2)::int AS "byName"
       FROM admin_attempts WHERE at > now() - interval '10 minutes' AND (ip = $1 OR name = $2)`,
    [ip, name],
  );
  const over = n > 10 || byName > 20;
  const [a] = await q<{ name: string; pass_hash: string }>(`SELECT name, pass_hash FROM admins WHERE name = $1`, [name]);
  if (!a || !(await verifySecret(String(body.password ?? ""), a.pass_hash))) {
    return over
      ? json(req, { ok: false, error: "Too many attempts. Wait 10 minutes." }, 429)
      : json(req, { ok: false, error: "Wrong name or password" }, 401);
  }
  await q(`DELETE FROM admin_attempts WHERE ctid = $1::tid`, [attempt]); // a correct login doesn't count against anyone
  const token = newToken();
  await q(`INSERT INTO admin_sessions (token_hash, admin) VALUES ($1, $2)`, [sha256(token), a.name]);
  return json(req, { ok: true, admin: a.name }, 200, { "set-cookie": cookie("aid", token, 86400, isSecure(req)) });
}
