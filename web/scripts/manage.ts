// Setup commands. Run with DATABASE_URL set (Neon URL or local Postgres):
//   node scripts/manage.ts init                      create tables (safe to re-run)
//   node scripts/manage.ts questions <file.csv>      replace ALL questions (only while in lobby)
//   node scripts/manage.ts admin <name> <password>   add or update an admin
//   node scripts/manage.ts allowlist <file.csv>      replace the allowlist (columns: email,name)
//   node scripts/manage.ts warm                      wake the database
//   node scripts/manage.ts purge-load                remove load-test players (f1999…) after a load test
//   node scripts/manage.ts mystery [game-dir] [--new-codes]
//                                                    load exhibits, case file and answer key from ../game
//                                                    (keeps existing codes unless --new-codes); prints the codes
//   node scripts/manage.ts codes                     print the exhibit codes again
//   node scripts/manage.ts roster <file.csv>         add emails to the mystery roster (column: email)
//   node scripts/manage.ts scoring <file.json|default> set the guesstimate rubric (also editable in Admin)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, scryptSync } from "node:crypto";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const pool = new pg.Pool({ connectionString: url, ssl: url.includes("neon.tech") ? { rejectUnauthorized: true } : undefined });

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

function records(file: string) {
  const [head, ...body] = parseCsv(readFileSync(file, "utf8"));
  const h = head.map((x) => x.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const hash = (s: string) => {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(s, salt, 32).toString("hex")}`;
};

async function printCodes() {
  const rows = (await pool.query(`SELECT n, title, code FROM clues ORDER BY n`)).rows;
  for (const r of rows) console.log(`Exhibit ${String(r.n).padStart(2)}  ${r.code.slice(0, 4)}-${r.code.slice(4)}  ${r.title}`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === "init") {
    await pool.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    console.log("schema ready");
  } else if (cmd === "questions") {
    const [{ mode }] = (await pool.query(`SELECT mode FROM game WHERE id = 1`)).rows;
    if (mode !== "lobby") throw new Error(`game is '${mode}': reset to lobby first`);
    const rs = records(a);
    const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v.replace(/[,\s]/g, "")));
    const qs = rs.map((r, idx) => {
      const kind = (r.kind || "q").toLowerCase();
      // answer alone = exact answer (low = high = answer); low/high give a band scored as "inside" instead.
      const answer = kind === "q" ? num(r.answer) : null;
      const low = kind === "q" ? num(r.low) ?? answer : null;
      const high = kind === "q" ? num(r.high) ?? answer : null;
      const x = {
        idx, kind, practice: /^(y|yes|true|1)$/i.test(r.practice), text: r.text, unit: r.unit ?? "",
        section: r.section ?? "", weight: num(r.weight) ?? 1, answer, low, high,
        seconds: Number(r.seconds), reveal_seconds: r.reveal_seconds === "" || r.reveal_seconds === undefined ? 10 : Number(r.reveal_seconds),
        note: r.note ?? "",
      };
      if (!x.text) throw new Error(`row ${idx + 2}: text missing`);
      if (kind !== "q" && kind !== "break") throw new Error(`row ${idx + 2}: kind must be q or break`);
      if (kind === "q" && !(x.low! > 0 && x.high! >= x.low!)) throw new Error(`row ${idx + 2}: need an answer > 0 (or 0 < low <= high)`);
      if (answer !== null && !(answer > 0)) throw new Error(`row ${idx + 2}: answer must be > 0`);
      if (!(x.weight > 0 && x.weight <= 100)) throw new Error(`row ${idx + 2}: weight must be > 0`);
      if (!(x.seconds >= 5 && x.seconds <= 900)) throw new Error(`row ${idx + 2}: seconds must be 5 to 900`);
      if (!(x.reveal_seconds >= 0 && x.reveal_seconds <= 900)) throw new Error(`row ${idx + 2}: reveal_seconds must be 0 to 900`);
      return x;
    });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM questions");
      for (const x of qs)
        await c.query(
          `INSERT INTO questions (idx, kind, practice, text, unit, low, high, seconds, reveal_seconds, note, section, weight, answer)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [x.idx, x.kind, x.practice, x.text, x.unit, x.low, x.high, x.seconds, x.reveal_seconds, x.note, x.section, x.weight, x.answer],
        );
      await c.query("UPDATE game SET version = version + 1, ranges_version = ranges_version + 1 WHERE id = 1");
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    const scored = qs.filter((x) => x.kind === "q" && !x.practice).length;
    const mins = qs.reduce((s, x) => s + x.seconds + 3 + x.reveal_seconds, 0) / 60;
    const maxPts = qs.filter((x) => x.kind === "q" && !x.practice).reduce((t, x) => t + x.weight, 0);
    console.log(`loaded ${qs.length} items (${scored} scored, total weight ${maxPts}); schedule ≈ ${mins.toFixed(1)} min after the countdown`);
  } else if (cmd === "admin") {
    if (!a || !b || b.length < 10) throw new Error("usage: admin <name> <password of 10+ chars>");
    await pool.query(`INSERT INTO admins (name, pass_hash) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET pass_hash = excluded.pass_hash`, [a, hash(b)]);
    console.log(`admin '${a}' saved`);
  } else if (cmd === "allowlist") {
    const rs = records(a);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM allowlist");
      for (const r of rs) await c.query(`INSERT INTO allowlist (email, name) VALUES (lower($1), nullif($2, '')) ON CONFLICT DO NOTHING`, [r.email, r.name ?? ""]);
      await c.query(`UPDATE players p SET name = a.name FROM allowlist a WHERE a.email = p.email AND a.name IS NOT NULL`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    console.log(`allowlist: ${rs.length} rows`);
  } else if (cmd === "purge-load") {
    const r = await pool.query(`DELETE FROM players WHERE email LIKE 'f1999%@goa.bits-pilani.ac.in'`);
    console.log(`removed ${r.rowCount} load-test players (and their answers and sessions). Now Admin → Reset game.`);
  } else if (cmd === "warm") {
    const t = Date.now();
    await pool.query("SELECT 1");
    console.log(`database awake (${Date.now() - t} ms)`);
  } else if (cmd === "mystery") {
    const dir = a && !a.startsWith("--") ? a : fileURLToPath(new URL("../../game/", import.meta.url));
    const fresh = process.argv.includes("--new-codes");
    const read = (f: string) => readFileSync(`${dir.replace(/\/$/, "")}/${f}`, "utf8");
    const clues = read("cards.md").split(/\n---\n/).map((p) => p.trim()).filter((p) => p.startsWith("## Exhibit")).map((p) => {
      const m = p.match(/^## Exhibit (\d+): (.+)\n> (.+)\n([\s\S]*)$/);
      if (!m) throw new Error(`can't parse exhibit starting: ${p.slice(0, 60)}`);
      return { n: Number(m[1]), title: m[2].trim(), description: m[3].trim(), body: m[4].trim() };
    });
    if (!clues.length) throw new Error("no exhibits found in cards.md");
    const caseFile = read("case-file.md");
    const key = read("answer-key.md");
    const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const newCode = () => Array.from({ length: 8 }, () => ALPHA[randomInt(ALPHA.length)]).join("");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const old = new Map((await c.query(`SELECT n, code FROM clues`)).rows.map((r) => [r.n as number, r.code as string]));
      const used = new Set<string>();
      await c.query(`DELETE FROM clues WHERE NOT (n = ANY($1::int[]))`, [clues.map((x) => x.n)]);
      for (const x of clues) {
        let code = !fresh && old.get(x.n) ? old.get(x.n)! : newCode();
        while (used.has(code)) code = newCode();
        used.add(code);
        await c.query(
          `INSERT INTO clues (n, title, description, body, code) VALUES ($1::int, $2, $3, $4, 'TMP' || $1::text)
           ON CONFLICT (n) DO UPDATE SET title = excluded.title, description = excluded.description, body = excluded.body, code = 'TMP' || excluded.n::text`,
          [x.n, x.title, x.description, x.body],
        );
        (x as { code?: string }).code = code;
      }
      for (const x of clues as { n: number; code: string }[]) await c.query(`UPDATE clues SET code = $2 WHERE n = $1`, [x.n, x.code]);
      await c.query(`INSERT INTO mystery_docs (key, body) VALUES ('case', $1), ('key', $2) ON CONFLICT (key) DO UPDATE SET body = excluded.body`, [caseFile, key]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    console.log(`loaded ${clues.length} exhibits, the case file and the answer key${fresh ? " (NEW codes)" : ""}`);
    await printCodes();
  } else if (cmd === "codes") {
    await printCodes();
  } else if (cmd === "roster") {
    const rs = records(a);
    for (const r of rs) await pool.query(`INSERT INTO roster (email) VALUES (lower($1)) ON CONFLICT DO NOTHING`, [r.email]);
    console.log(`roster: added ${rs.length} rows`);
  } else if (cmd === "scoring") {
    const { parseBands, describeBands } = await import("../lib/scoring.ts");
    const parsed = a === "default" ? null : parseBands(readFileSync(a, "utf8"));
    if (typeof parsed === "string") throw new Error(`rubric: ${parsed}`);
    await pool.query(`UPDATE game SET scoring = $1::jsonb, ranges_version = ranges_version + 1, version = version + 1 WHERE id = 1`, [parsed === null ? null : JSON.stringify(parsed)]);
    console.log(parsed ? describeBands(parsed).map(([l, p]) => `${l}: ${p}`).join("\n") : "rubric reset to the default");
  } else {
    console.log("commands: init | questions <csv> | admin <name> <password> | allowlist <csv> | warm | purge-load | mystery [dir] [--new-codes] | codes | roster <csv> | scoring <json|default>");
  }
} finally {
  await pool.end();
}
