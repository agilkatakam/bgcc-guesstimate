import { q } from "@/lib/db";
import { normaliseEmail, cleanName } from "@/lib/parse";
import { checkPost, json, preflight, hashSecret, verifySecret, newToken, sha256, cookie, isSecure, displayName, clientIp } from "@/lib/http";

export const dynamic = "force-dynamic";

const PIN = /^\d{4}$/;
const MAX_SESSIONS = 4;

// Bot guard: login attempts per network address per minute, kept in memory (one server process).
// High enough for a whole campus behind one shared address (~1,000 students), low enough that a
// script can't grab thousands of BITS IDs or flood the server with PIN checks.
const PER_IP_PER_MIN = 1500;
const hits = new Map<string, { start: number; n: number }>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > 60_000) {
    if (hits.size > 50_000) hits.clear();
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  return ++h.n > PER_IP_PER_MIN;
}

export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  if (tooMany(clientIp(req))) return json(req, { ok: false, error: "Too many logins from this network right now. Wait a minute and try again." }, 429);
  const body = (await req.json().catch(() => ({}))) as { email?: string; pin?: string; name?: string; check?: boolean };
  const pattern = process.env.EMAIL_PATTERN ? new RegExp(process.env.EMAIL_PATTERN, "i") : undefined;
  const email = normaliseEmail(String(body.email ?? ""), pattern);
  if (!email) return json(req, { ok: false, error: "Use your BITS Goa email, like f20250123@goa.bits-pilani.ac.in" }, 400);
  const pin = String(body.pin ?? "");
  if (!PIN.test(pin)) return json(req, { ok: false, error: "PIN must be 4 digits" }, 400);
  // The name is needed only the first time (it goes on the leaderboard). Later logins ignore it.
  const rawName = String(body.name ?? "").slice(0, 200);
  const typedName = rawName.trim() ? cleanName(rawName) : null;

  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM allowlist`);
  let listedName: string | null = null;
  if (n > 0) {
    const rows = await q<{ name: string | null }>(`SELECT name FROM allowlist WHERE email = $1`, [email]);
    if (!rows.length) return json(req, { ok: false, error: "This email isn't on the event list. Ask an organiser." }, 403);
    listedName = rows[0].name;
  }

  // Existing player: verify the PIN. New player: create with this PIN.
  let playerId!: number;
  let first = false;
  let [p] = await q<{ id: number; pin_hash: string; locked: boolean }>(
    `SELECT id, pin_hash, coalesce(locked_until > now(), false) AS locked FROM players WHERE email = $1`,
    [email],
  );
  if (!p) {
    // The phone asks first (check: true) so a mistyped ID doesn't silently create someone else's account.
    if (body.check === true) return json(req, { ok: false, confirmNew: true, error: "No account for this BITS ID yet." }, 409);
    const name = listedName ?? typedName;
    if (!name) {
      return json(req, { ok: false, error: rawName.trim() ? "Name: 2 to 40 letters (spaces, . ' - are fine)" : "First time here: enter your name too", needName: true }, 400);
    }
    const created = await q<{ id: number }>(
      `INSERT INTO players (email, name, pin_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, name, await hashSecret(pin)],
    );
    if (created.length) {
      playerId = created[0].id;
      first = true;
    } else {
      // lost a race with a simultaneous first login: fall through to verification
      [p] = await q(`SELECT id, pin_hash, coalesce(locked_until > now(), false) AS locked FROM players WHERE email = $1`, [email]);
    }
  }
  if (!first) {
    // Reserve this attempt BEFORE checking the PIN, in one statement: it counts as a failure (every 5th locks:
    // 1 min, then 2, 4, 8, 16, then 30 min) unless the PIN turns out right. So parallel guesses can't slip
    // past the limit: once the lock is set, every other request gets no row back.
    const reserved = await q(
      `UPDATE players
          SET failed_pins  = failed_pins + 1,
              locked_until = CASE WHEN (failed_pins + 1) % 5 = 0
                                  THEN now() + least(interval '10 minutes', interval '1 minute' * power(2, (failed_pins + 1) / 5 - 1))
                                  ELSE locked_until END
        WHERE id = $1 AND coalesce(locked_until, '-infinity') <= now()
        RETURNING id`,
      [p.id],
    );
    if (!reserved.length) return json(req, { ok: false, error: "Too many wrong PINs. Wait a few minutes, or ask an organiser to reset your PIN." }, 429);
    if (!(await verifySecret(pin, p.pin_hash))) {
      return json(req, { ok: false, error: "Wrong PIN. Forgot it? Ask an organiser to reset it." }, 401);
    }
    playerId = p.id;
    // right PIN: the count (and any lock this attempt just set) is cleared
    await q(`UPDATE players SET failed_pins = 0, locked_until = NULL WHERE id = $1`, [playerId]);
  }

  const token = newToken();
  await q(`INSERT INTO sessions (token_hash, player_id, user_agent) VALUES ($1, $2, $3)`, [sha256(token), playerId, (req.headers.get("user-agent") ?? "").slice(0, 200)]);
  // keep only the newest MAX_SESSIONS sessions
  await q(
    `DELETE FROM sessions WHERE player_id = $1 AND token_hash NOT IN
       (SELECT token_hash FROM sessions WHERE player_id = $1 ORDER BY created_at DESC LIMIT ${MAX_SESSIONS})`,
    [playerId],
  );
  const [pl] = await q<{ name: string | null; email: string }>(`SELECT name, email FROM players WHERE id = $1`, [playerId]);
  return json(
    req,
    { ok: true, token, playerId, name: displayName(pl), first },
    200,
    { "set-cookie": cookie("sid", token, 7 * 86400, isSecure(req)) },
  );
}

export const OPTIONS = preflight;
