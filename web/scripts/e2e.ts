// End-to-end smoke test against a running server with a FRESH game in the lobby.
// Loads short test questions first:  node scripts/manage.ts questions scripts/e2e-questions.csv
// Usage: BASE=http://localhost:3100 ADMIN=akhil ADMIN_PASS=... node scripts/e2e.ts
const BASE = process.env.BASE ?? "http://localhost:3100";
const H = { "content-type": "application/json", origin: BASE };
let fails = 0;
const check = (cond: boolean, msg: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, body: unknown, auth?: string) =>
  fetch(BASE + path, { method: "POST", headers: { ...H, ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });

async function adminCookie() {
  const r = await post("/api/admin/login", { name: process.env.ADMIN, password: process.env.ADMIN_PASS });
  check(r.ok, "admin login");
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}
async function admin(cookie: string, body: Record<string, unknown>) {
  const s = await (await fetch(BASE + "/api/admin/state", { headers: { cookie } })).json();
  const r = await fetch(BASE + "/api/admin/action", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ version: s.version, ...body }) });
  return r.json();
}
const state = async () => (await fetch(BASE + "/api/state?k=t")).json();

// ---- logins ----
const bad = await post("/api/login", { email: "x@gmail.com", pin: "1234" });
check(bad.status === 400, "non-BITS email rejected");
const noName = await post("/api/login", { email: "f20250001", pin: "1111" });
check(noName.status === 400 && (await noName.json()).needName === true, "first login without a name refused");
const badName = await post("/api/login", { email: "f20250001", pin: "1111", name: "<b>1</b>" });
check(badName.status === 400, "junk name refused");
const p1 = await (await post("/api/login", { email: "f20250001@goa.bits-pilani.ac.in", pin: "1111", name: "  Asha   Rao " })).json();
check(p1.ok && p1.first && p1.name === "Asha Rao", "player 1 created, name cleaned");
const p1b = await post("/api/login", { email: "F20250001@goa.bits-pilani.ac.in", pin: "9999" });
check(p1b.status === 401, "wrong PIN rejected");
const p1c = await (await post("/api/login", { email: "f20250001", pin: "1111" })).json();
check(p1c.ok && !p1c.first && p1c.name === "Asha Rao", "same ID + PIN = same account, no name needed");
const p1d = await (await post("/api/login", { email: "f20250001", pin: "1111", name: "Someone Else" })).json();
check(p1d.ok && p1d.name === "Asha Rao", "returning login ignores a typed name");
const old = await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } });
check(old.status === 200, "up to 4 devices stay logged in (a 3rd login keeps the 1st)");
p1.token = p1d.token;
const p2 = await (await post("/api/login", { email: "f20250002@goa.bits-pilani.ac.in", pin: "2222", name: "Bo" })).json();
const p3 = await post("/api/login", { email: "f20250003@goa.bits-pilani.ac.in", pin: "3333", name: "Chitra Iyer" });
check(p3.ok, "player 3 created");
const cross = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
check(cross.status === 400, "foreign origin rejected");

// ---- lobby ----
let s = await state();
check(s.phase === "lobby" && s.text === null, "lobby, no question text");
const early = await (await post("/api/answer", { item: 0, value: "5", seq: 1 }, p1.token)).json();
check(early.ok === false && early.error === "closed", "answers refused in lobby");

const ac = await adminCookie();
check((await admin(ac, { action: "lobbyNote", note: "Starts around 5:10 to 5:15 PM" })).ok, "lobby note saved");
await sleep(400);
s = await state();
check(s.lobbyNote === "Starts around 5:10 to 5:15 PM", "lobby note public in the lobby");
check(s.qTotal === 2, "state knows the number of scored questions");
const meL = await (await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } })).json();
check(meL.plan?.length === 2 && meL.plan[1].weight === 3, "me: game plan for the lobby");
check((await admin(ac, { action: "start", confirm: "nope" })).ok === false, "start needs confirmation");
check((await admin(ac, { action: "start", confirm: "START", countdown: 3 })).ok, "game started with a 3 s countdown");
check((await admin(ac, { action: "start", confirm: "START" })).ok === false, "second start refused");
await sleep(400);
s = await state();
check(s.phase === "countdown" && s.index === 0 && s.text === null && s.lobbyNote === "", "countdown: no question text yet");
check(s.nextChangeAt === s.opensAt && s.opensAt - s.serverNow > 1500, "countdown ends when item 0 opens");
const cd = await (await post("/api/answer", { item: 0, value: "5", seq: 2 }, p1.token)).json();
check(cd.ok === false, "answers refused during the countdown");
await sleep(Math.max(0, s.opensAt - s.serverNow) + 400);

s = await state();
check(s.phase === "open" && s.index === 0 && typeof s.text === "string" && s.range === null, "item 0 open, text shown, range hidden");
const r1 = await (await post("/api/answer", { item: 0, value: "1,500", seq: 10 }, p1.token)).json();
check(r1.ok && r1.value === 1500, "answer saved, commas ok");
const stale = await (await post("/api/answer", { item: 0, value: "9", seq: 5 }, p1.token)).json();
check(stale.ok && stale.value === 1500, "older seq ignored");
const junk = await post("/api/answer", { item: 0, value: "12abc", seq: 11 }, p1.token);
check(junk.status === 400, "non-number rejected");
const huge = await post("/api/answer", { item: 0, value: "99999999999999999999", seq: 12 }, p1.token);
check(huge.status === 400, "huge number rejected");
const future = await (await post("/api/answer", { item: 1, value: "5", seq: 13 }, p1.token)).json();
check(future.ok === false, "future item refused");
const noauth = await post("/api/answer", { item: 0, value: "5", seq: 14 });
check(noauth.status === 401, "answer without login refused");
await post("/api/answer", { item: 0, value: "30000", seq: 20 }, p2.token);

// pause / resume
check((await admin(ac, { action: "pause" })).ok, "paused");
s = await state();
check(s.paused && s.nextChangeAt === null, "state shows paused");
await sleep(2500);
check((await admin(ac, { action: "resume" })).ok, "resumed");

// wait for close, check grace and the reveal gap
s = await state();
await sleep(Math.max(0, s.closesAt - s.serverNow) + 500);
const grace = await (await post("/api/answer", { item: 0, value: "1600", seq: 30 }, p1.token)).json();
check(grace.ok, "answer accepted inside 2 s grace");
s = await state();
check(s.phase === "closing" && s.range === null, "closing gap: range still hidden");
await sleep(2200);
const late = await (await post("/api/answer", { item: 0, value: "1700", seq: 40 }, p1.token)).json();
check(late.ok === false, "answer refused after grace");
s = await state();
await sleep(Math.max(0, s.revealAt - s.serverNow) + 300);
s = await state();
check(s.phase === "reveal" && s.range && s.range.answer === 1500, "reveal shows the answer");
const me1 = await (await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } })).json();
const it0 = me1.items.find((i: { idx: number }) => i.idx === 0);
check(it0.value === 1600 && it0.penalty !== null, "me: value after grace and penalty shown");
check((await admin(ac, { action: "jump", item: 0, confirm: "0" })).ok === false, "can't reopen a revealed item");
check((await admin(ac, { action: "extend", seconds: 15 })).ok === false, "can't extend during reveal");

// jump ahead to item 2 (scored) and answer; then finish
check((await admin(ac, { action: "jump", item: 2, confirm: "2" })).ok, "jump to item 2");
s = await state();
check(s.index === 2 && s.phase === "open", "item 2 open");
check(s.section === "Easy" && s.weight === 1 && s.qn === 1 && s.label === "Easy · Q1 of 2", "section, weight and numbering");
await post("/api/answer", { item: 2, value: "50", seq: 50 }, p1.token);
await post("/api/answer", { item: 2, value: "5000", seq: 50 }, p2.token);
s = await state();
await sleep(Math.max(0, s.revealAt - s.serverNow) + 300);
const hidden = await (await fetch(BASE + "/api/leaderboard")).json();
check(!hidden.ready && hidden.top.length === 0, "leaderboard hidden from players during the game");
const meMid = await (await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } })).json();
check(meMid.rank === null && meMid.total === 3, "me: own points during the game, no rank");
const adm = await (await fetch(BASE + "/api/admin/ranking", { headers: { cookie: ac } })).json();
check(adm.rows?.[0]?.name === "Asha Rao", "organisers see the live ranking");
check((await admin(ac, { action: "finish", confirm: "FINISH" })).ok, "finished");
let lb = await (await fetch(BASE + "/api/leaderboard")).json();
for (let i = 0; i < 10 && !lb.ready; i++) { await sleep(300); lb = await (await fetch(BASE + "/api/leaderboard")).json(); }
check(lb.ready && lb.top.length >= 3, "leaderboard public after the game");
check(lb.top[0].name === "Asha Rao" && lb.top[0].total === 3, "best player first with her name (80 vs 50 = within 2x = 3 points)");
const ps = await (await fetch(BASE + "/api/admin/players?q=f20250002", { headers: { cookie: ac } })).json();
const ren = await fetch(BASE + "/api/admin/players", { method: "POST", headers: { ...H, cookie: ac }, body: JSON.stringify({ id: ps.rows[0].id, action: "rename", name: "Bo Dee" }) });
check(ren.ok, "admin renames a player");
let lb2 = await (await fetch(BASE + "/api/leaderboard")).json();
for (let i = 0; i < 10 && !lb2.top.some((r: { name: string }) => r.name === "Bo Dee"); i++) { await sleep(300); lb2 = await (await fetch(BASE + "/api/leaderboard")).json(); }
check(lb2.top.some((r: { name: string }) => r.name === "Bo Dee"), "leaderboard shows the new name");
const csv = await fetch(BASE + "/api/admin/export", { headers: { cookie: ac } });
check(csv.ok && (await csv.text()).split("\n").length >= 4, "CSV export");
s = await state();
check(s.phase === "results", "results phase");
let me3 = await (await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } })).json();
check(me3.rank === 1 && me3.qualifyCount === 0, "results: rank shown, cut not public yet");
check((await admin(ac, { action: "announce", confirm: "ANNOUNCE" })).ok === false, "can't announce before picking N");
check((await admin(ac, { action: "qualify", qualifyCount: 1 })).ok, "cut set privately");
me3 = await (await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } })).json();
check(me3.qualifyCount === 0, "cut still hidden before Announce");
check((await admin(ac, { action: "announce", confirm: "ANNOUNCE" })).ok, "announced");
me3 = await (await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${p1.token}` } })).json();
const lb3 = await (await fetch(BASE + "/api/leaderboard")).json();
check(me3.qualifyCount === 1 && me3.eligibleRank === 1 && lb3.qualifyCount === 1, "after Announce: phones and leaderboard see top 1");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
