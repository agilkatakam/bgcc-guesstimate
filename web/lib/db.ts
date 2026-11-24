import "server-only";
import { neon } from "@neondatabase/serverless";
import pg from "pg";

// One query function for both hosts: a normal pg pool on our own server
// (DATABASE_DRIVER=pg, the chosen setup) and Neon's HTTP driver as a fallback.

type Q = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

let impl: Q | null = null;
let pool: pg.Pool | null = null;

const usePg = () => {
  const url = process.env.DATABASE_URL ?? "";
  return process.env.DATABASE_DRIVER === "pg" || !url.includes("neon.tech");
};

function make(): Q {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  if (usePg()) {
    pool ??= new pg.Pool({ connectionString: url, max: 20 });
    return async (text, params = []) => (await pool!.query(text, params)).rows;
  }
  const sql = neon(url);
  return async (text, params = []) => (await sql.query(text, params)) as never;
}

export const q: Q = (text, params) => {
  impl ??= make();
  return impl(text, params);
};

/**
 * Run fn inside one transaction (pg only). Used where a check and a write must not race,
 * e.g. "team not full, then join". On the Neon HTTP fallback there are no interactive
 * transactions, so fn runs with plain queries (the old behaviour).
 */
export async function tx<T>(fn: (query: Q) => Promise<T>): Promise<T> {
  impl ??= make();
  if (!pool) return fn(q);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const query: Q = async (text, params = []) => (await c.query(text, params)).rows;
    const out = await fn(query);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// The public /api/state body is cached for a moment (see app/api/state/route.ts). Anything that
// changes the game calls this so the next request rebuilds it. globalThis: one value per process,
// shared by every route bundle.
const G = globalThis as unknown as { __vardhanStateChangedAt?: number };
export const markStateChanged = () => { G.__vardhanStateChangedAt = Date.now(); };
export const stateChangedAt = () => G.__vardhanStateChangedAt ?? 0;
