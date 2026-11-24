// Load test: N simulated phones play a full game the way the real client does.
// Run ONLY against a local/backup build, never against Vercel (Hobby limits; see ARCHITECTURE.md §8).
//
//   createdb vardhan_load_test
//   export DATABASE_URL=postgres://localhost/vardhan_load_test DATABASE_DRIVER=pg
//   node scripts/manage.ts init && node scripts/manage.ts questions scripts/load-questions.csv
//   node scripts/manage.ts admin loadadmin loadpass12345
//   npm run build && npx next start -p 3200 &
//   BASE=http://localhost:3200 ADMIN=loadadmin ADMIN_PASS=loadpass12345 N=600 node scripts/load.ts
//
// What it checks: every request's status and latency; that each player's last confirmed answer is what the
// server stored; that no answer was accepted after its question closed; that every phone saw every phase.
setInterval(() => {}, 1000); // keep the event loop alive so request timeouts always fire
const BASE = process.env.BASE ?? "http://localhost:3200";
const N = Number(process.env.N ?? 600);
const H = { "content-type": "application/json", origin: BASE };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

type State = { key: string; phase: string; index: number | null; kind: string | null; practice: boolean; closesAt: number | null; nextChangeAt: number | null; serverNow: number; count: number };
const stats = new Map<string, { ms: number[]; codes: Map<number, number> }>();
function note(ep: string, ms: number, code: number) {
  let s = stats.get(ep);
  if (!s) stats.set(ep, (s = { ms: [], codes: new Map() }));
  s.ms.push(ms);
  s.codes.set(code, (s.codes.get(code) ?? 0) + 1);
}
async function call<T>(ep: string, path: string, init: RequestInit = {}, timeoutMs = 3500): Promise<{ status: number; data: T | null }> {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const data = (await r.json().catch(() => null)) as T | null;
    note(ep, performance.now() - t0, r.status);
    return { status: r.status, data };
  } catch {
    note(ep, performance.now() - t0, 0); // 0 = timeout / network error
    return { status: 0, data: null };
  }
}
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);

// ---- admin ----
const login = await fetch(BASE + "/api/admin/login", { method: "POST", headers: H, body: JSON.stringify({ name: process.env.ADMIN, password: process.env.ADMIN_PASS }) });
if (!login.ok) throw new Error("admin login failed");
const AC = (login.headers.get("set-cookie") ?? "").split(";")[0];
const adminState = async () => (await (await fetch(BASE + "/api/admin/state", { headers: { cookie: AC } })).json()) as { version: number; game: { mode: string } };
const adminAct = async (body: Record<string, unknown>) => {
  const v = (await adminState()).version;
  return (await fetch(BASE + "/api/admin/action", { method: "POST", headers: { ...H, cookie: AC }, body: JSON.stringify({ ...body, version: v }) })).json();
};
if ((await adminState()).game.mode !== "lobby") await adminAct({ action: "reset", confirm: "RESET EVERYTHING" });

// ---- players log in (spread over ~20 s, as they would arrive) ----
// Test accounts use the impossible year 1999 so they never collide with real IDs (first-years are f2026xxxx).
// Remove them afterwards: node scripts/manage.ts purge-load, then Admin → Reset game.
const email = (i: number) => `f1999${String(i).padStart(4, "0")}@goa.bits-pilani.ac.in`;
const tokens: string[] = [];
console.log(`logging in ${N} players…`);
await Promise.all(Array.from({ length: N }, async (_, i) => {
  await sleep(rand(0, 20_000));
  for (let a = 0; a < 3 && !tokens[i]; a++) {
    const r = await call<{ token: string }>("POST /api/login", "/api/login", { method: "POST", headers: H, body: JSON.stringify({ email: email(i), pin: "2468", name: `Load ${i}` }) }, 8000);
    if (r.data?.token) tokens[i] = r.data.token;
  }
}));
const loggedIn = tokens.filter(Boolean).length;
console.log(`logged in: ${loggedIn}/${N}`);

// ---- lobby, then start with the 10 s countdown (phones are already polling the lobby) ----
const t0 = Date.now();
setTimeout(() => void adminAct({ action: "start", confirm: "START", countdown: 10 }).then((r) => console.log("game started", r.ok ? "" : r)), 15_000);

type Saved = { value: number; seq: number };
const confirmed: Map<number, Saved>[] = Array.from({ length: N }, () => new Map());
const seenPhases: Set<string>[] = Array.from({ length: N }, () => new Set());
const uncertain: Set<number>[] = Array.from({ length: N }, () => new Set());
let lateAccepted = 0;

async function phone(i: number) {
  const token = tokens[i];
  if (!token) return;
  const auth = { ...H, authorization: `Bearer ${token}` };
  let seq = 0;
  let key = "init";
  let answeredItem = -1;
  for (;;) {
    const r = await call<State>("GET /api/state", `/api/state?k=${encodeURIComponent(key)}`, {}, 4000);
    if (!r.data) { await sleep(3000); continue; }
    const s = r.data;
    key = s.key;
    seenPhases[i].add(`${s.index}-${s.phase}`);
    if (s.phase === "results") break;

    // Answer once per open question: 1–3 saves, 20% of phones leave the last one to the final second.
    if (s.phase === "open" && s.kind === "q" && s.index !== null && s.index !== answeredItem && s.closesAt) {
      answeredItem = s.index;
      const item = s.index;
      const left = s.closesAt - s.serverNow;
      const saves = 1 + Math.floor(Math.random() * 3);
      const lastMinute = Math.random() < 0.2;
      const start = Date.now();
      const times = Array.from({ length: saves }, () => rand(0, left * 0.8)).sort((x, y) => x - y);
      if (lastMinute) times[times.length - 1] = left - rand(100, 900);
      void (async () => {
        for (const at of times) {
          await sleep(start + at - Date.now());
          const value = Math.round(rand(1, 5000));
          const mySeq = ++seq;
          const a = await call<{ ok: boolean; seq: number; value: number; closesAt: number; serverNow: number }>("POST /api/answer", "/api/answer", { method: "POST", headers: auth, body: JSON.stringify({ item, value: String(value), seq: mySeq }) }, 3500);
          if (a.status === 200 && a.data?.ok) {
            const prev = confirmed[i].get(item);
            if (!prev || a.data.seq >= prev.seq) confirmed[i].set(item, { value: a.data.value, seq: a.data.seq });
            if (a.data.closesAt && a.data.serverNow > a.data.closesAt + 2000) lateAccepted++;
          } else if (a.status === 0) uncertain[i].add(item); // timed out: the server may or may not have stored it
        }
      })();
    }

    // After a reveal, fetch scores with 0–3 s jitter (as the client does).
    if (s.phase === "reveal") void (async () => { await sleep(rand(0, 3000)); await call("GET /api/me", "/api/me", { headers: auth }); })();

    // Client sync rule: sleep until the next change (+0–1 s jitter), else poll every 10 s (4–5 s in the lobby).
    const idle = s.phase === "lobby" ? rand(4000, 5000) : 10_000;
    const wait = s.nextChangeAt !== null ? s.nextChangeAt - s.serverNow + rand(0, 1000) : idle;
    await sleep(Math.min(wait, 10_000));
  }
}
await Promise.all(Array.from({ length: N }, (_, i) => phone(i)));
const secs = (Date.now() - t0) / 1000;

// ---- verify what the server stored ----
let mismatches = 0, checked = 0;
await Promise.all(tokens.map(async (token, i) => {
  if (!token) return;
  await sleep(rand(0, 5000));
  const r = await call<{ items: { idx: number; value: number | null }[] }>("GET /api/me (verify)", "/api/me", { headers: { ...H, authorization: `Bearer ${token}` } }, 8000);
  for (const [item, saved] of confirmed[i]) {
    if (uncertain[i].has(item)) continue;
    checked++;
    const got = r.data?.items.find((x) => x.idx === item)?.value;
    if (got !== saved.value) mismatches++;
  }
}));
const phasesExpected = Math.max(...seenPhases.map((s) => s.size));
const missedPhases = seenPhases.filter((s, i) => tokens[i] && s.size < phasesExpected - 2).length;

console.log(`\ngame ran ${secs.toFixed(0)} s with ${loggedIn} phones\n`);
console.log("endpoint                 count    p50    p95    p99    max   statuses");
let bad = 0;
for (const [ep, s] of stats) {
  const codes = [...s.codes].map(([c, n]) => `${c}:${n}`).join(" ");
  for (const [c, n] of s.codes) if (c === 0 || c >= 500) bad += n;
  console.log(`${ep.padEnd(24)} ${String(s.ms.length).padStart(6)} ${pct(s.ms, 50).toFixed(0).padStart(6)} ${pct(s.ms, 95).toFixed(0).padStart(6)} ${pct(s.ms, 99).toFixed(0).padStart(6)} ${Math.max(...s.ms).toFixed(0).padStart(6)}   ${codes}`);
}
console.log(`\nanswers checked against the server: ${checked}, mismatches: ${mismatches}`);
console.log(`answers accepted after close + 2 s grace: ${lateAccepted}`);
console.log(`phones that missed phases: ${missedPhases}`);
const sawCountdown = seenPhases.filter((s, i) => tokens[i] && s.has("0-countdown")).length;
console.log(`phones that saw the countdown: ${sawCountdown}/${loggedIn}`);
console.log(`timeouts / 5xx: ${bad}`);
const fail = loggedIn < N || mismatches > 0 || lateAccepted > 0 || bad > 0 || sawCountdown < loggedIn;
console.log(fail ? "\nLOAD TEST FAILED" : "\nLOAD TEST PASSED");
process.exit(fail ? 1 : 0);
