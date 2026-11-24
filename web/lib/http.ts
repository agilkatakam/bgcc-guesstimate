import "server-only";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { q } from "./db";

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, n: number) => Promise<Buffer>;

/** JSON response, never cached, with CORS for allowed alternate origins. */
export const json = (req: Request, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers, ...corsHeaders(req) },
  });

// ---- CORS: the page may retry against the second hostname with a bearer token ----

export const allowedOrigins = () => (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!allowedOrigins().includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
}

export const preflight = (req: Request) => new Response(null, { status: 204, headers: corsHeaders(req) });

/** POSTs must be JSON from this host or an allowed origin. Returns an error string or null. */
export function checkPost(req: Request): string | null {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return "json only";
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { return "bad origin"; }
    if (originHost !== host && !allowedOrigins().includes(origin)) return "bad origin";
  }
  return null;
}

// ---- hashing ----

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, 32);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(secret, Buffer.from(saltHex, "hex"), 32);
  const want = Buffer.from(keyHex, "hex");
  return key.length === want.length && timingSafeEqual(key, want);
}

// ---- player auth ----

export function tokenFrom(req: Request, cookieName: string): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|; )${cookieName}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export type Player = { id: number; email: string; name: string | null; disqualified: boolean };

export async function playerFrom(req: Request): Promise<Player | null> {
  const t = tokenFrom(req, "sid");
  if (!t) return null;
  const rows = await q<Player>(
    `SELECT p.id, p.email, p.name, p.disqualified FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = $1`,
    [sha256(t)],
  );
  return rows[0] ?? null;
}

export async function adminFrom(req: Request): Promise<string | null> {
  // Admins use only the aid cookie. (The browser may also send a PLAYER's bearer token if the organiser
  // played on the same phone; that must not hide the admin cookie.)
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|; )aid=([^;]+)/);
  const t = m ? decodeURIComponent(m[1]) : null;
  if (!t) return null;
  const rows = await q<{ admin: string }>(
    `SELECT admin FROM admin_sessions WHERE token_hash = $1 AND created_at > now() - interval '24 hours'`,
    [sha256(t)],
  );
  return rows[0]?.admin ?? null;
}

export const cookie = (name: string, value: string, maxAge: number, secure: boolean) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

export const isSecure = (req: Request) =>
  (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";

/**
 * The client's address for rate limits. Caddy (our proxy) sets X-Forwarded-For to the real client address,
 * so the RIGHTMOST entry is the one our proxy saw; anything to its left could be typed by the client.
 */
export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "local").split(",").map((s) => s.trim()).filter(Boolean).pop() ?? "local";

export const displayName = (p: { name: string | null; email: string }) => p.name ?? p.email.split("@")[0];
