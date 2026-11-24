// End-to-end test of Round 2 (teams with a lead, open exhibits, fewest opened wins) against a running server.
// Part 1: answers on the website (answersOnline on). Part 2: the default flow: exhibits by code, answers in person
// ("Answer given" by an organiser), organisers choosing the number of teams, and the max-teams limit.
// Needs exhibits loaded (node scripts/manage.ts mystery) and an admin.
// Usage: BASE=http://localhost:3300 ADMIN=tester ADMIN_PASS=... node scripts/e2e-mystery.ts
// WARNING: resets Round 2 (teams, opened exhibits, submissions) and the roster. Never run against the live event.
// Test players use the impossible year 1999 (f1999xxxx); remove them after: node scripts/manage.ts purge-load
const BASE = process.env.BASE ?? "http://localhost:3300";
const H = { "content-type": "application/json", origin: BASE };
let fails = 0;
const check = (cond: boolean, msg: string, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}${!cond && extra !== undefined ? `  -> ${JSON.stringify(extra).slice(0, 300)}` : ""}`);
  if (!cond) fails++;
};

type Auth = { token?: string; cookie?: string };
async function call(path: string, body?: unknown, auth?: Auth, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...H, ...headers };
  if (auth?.token) h.authorization = `Bearer ${auth.token}`;
  if (auth?.cookie) h.cookie = auth.cookie;
  const r = await fetch(BASE + path, body === undefined ? { headers: h } : { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, data, text };
}

const login = await fetch(BASE + "/api/admin/login", { method: "POST", headers: H, body: JSON.stringify({ name: process.env.ADMIN, password: process.env.ADMIN_PASS }) });
check(login.ok, "admin login");
const A: Auth = { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
const admin = (body: Record<string, unknown>) => call("/api/admin/mystery", body, A);
const team = (p: Auth, body: Record<string, unknown>) => call("/api/mystery/team", body, p);
const me = async (p: Auth) => (await call("/api/mystery/me", undefined, p)).data;

check((await admin({ action: "reset", confirm: "RESET MYSTERY" })).status === 200, "reset round 2");
await admin({ action: "rosterClear", confirm: "CLEAR" });
check((await admin({ action: "settings", maxTeamSize: 3, unlockMode: "tap", openBy: "lead", answersOnline: true, maxTeams: 0 })).status === 200, "settings: size 3, tap, lead only, answers online");

// ---- players (bare ID login) ----
const ID = (i: number) => `f1999${String(9000 + i)}`;
const P: Auth[] = [];
const noName = await call("/api/login", { email: ID(99), pin: "4321" });
check(noName.status === 400 && noName.data?.needName === true, "first login without a name is refused (needName)", noName.data);
for (let i = 1; i <= 9; i++) {
  const r = await call("/api/login", { email: i % 2 ? ID(i) : ` ${ID(i).toUpperCase()}@goa.bits-pilani.ac.in `, pin: "4321", name: `Tester ${i}` });
  check(r.status === 200 && !!r.data?.token, `player ${i} logs in with ${i % 2 ? "bare ID" : "full email"}`, r.data);
  P[i] = { token: r.data?.token };
}
check((await call("/api/login", { email: ID(1), pin: "1111" })).status === 401, "wrong PIN refused");
check((await call("/api/login", { email: ID(1), pin: "4321" })).status === 200, "later logins don't need the name");

let m = await me(P[1]);
check(m.stage === "closed" && m.team === undefined && m.catalogue === undefined, "closed by default, nothing leaks", m);
check((await team(P[1], { action: "create", name: "Alpha" })).status === 409, "can't create a team while closed");

// ---- team forming ----
await admin({ action: "stage", stage: "teams" });
m = await me(P[1]);
check(m.stage === "teams" && m.allowed === true && m.catalogue?.length === 12, "teams stage: allowed, 12 exhibit titles visible", m);
check(!JSON.stringify(m).includes('"body"') && !JSON.stringify(m).includes('"code"'), "me never carries exhibit bodies or codes");

let r = await team(P[1], { action: "create", name: "  Alpha   " });
check(r.status === 200 && /^[A-Z0-9]{5}$/.test(r.data?.joinCode), "P1 creates Alpha, gets a 5-char join code", r.data);
const alphaCode: string = r.data?.joinCode;
check((await team(P[1], { action: "create", name: "Again" })).status === 400, "can't create a second team while in one");
r = await team(P[2], { action: "join", code: `${alphaCode.slice(0, 2).toLowerCase()}-${alphaCode.slice(2)}` });
check(r.status === 200, "P2 joins with a lower-case, dashed code", r.data);
check((await team(P[3], { action: "join", code: alphaCode })).status === 200, "P3 joins");
r = await team(P[4], { action: "join", code: alphaCode });
check(r.status === 400 && /full/.test(r.data?.error), "P4 refused: Alpha is full (3)", r.data);
check((await team(P[4], { action: "create", name: "ALPHA" })).status === 400, "team names are unique, any case");
r = await team(P[4], { action: "create", name: "Beta" });
const betaCode: string = r.data?.joinCode;
check(r.status === 200, "P4 creates Beta");
check((await team(P[5], { action: "join", code: betaCode })).status === 200, "P5 joins Beta");

// Race: two players grab Beta's last slot at once.
const [j6, j7] = await Promise.all([team(P[6], { action: "join", code: betaCode }), team(P[7], { action: "join", code: betaCode })]);
check([j6.status, j7.status].filter((s) => s === 200).length === 1, "race for the last slot: exactly one gets in", [j6.data, j7.data]);
const betaThird = j6.status === 200 ? 6 : 7, loser = j6.status === 200 ? 7 : 6;
m = await me(P[4]);
check(m.team?.members.length === 3, "Beta has exactly 3", m.team);

// Wrong join codes are rate-limited.
let last = 0;
for (let i = 0; i < 9; i++) last = (await team(P[8], { action: "join", code: "ZZZZZ" })).status;
check(last === 429, "9th wrong join code in a minute is refused (429)", last);

// Lead powers.
check((await team(P[2], { action: "remove", playerId: m.team?.members[0].id })).status === 403, "a member can't remove people");
const ids = (await me(P[1])).team.members.map((x: any) => x.id);
check((await team(P[1], { action: "makeLead", playerId: ids[1] })).status === 200, "lead hands lead to P2");
check((await me(P[3])).team.leadId === ids[1], "everyone sees P2 as lead");
check((await team(P[2], { action: "makeLead", playerId: ids[0] })).status === 200, "P2 hands it back");
check((await team(P[3], { action: "leave" })).status === 200, "P3 leaves");
check((await team(P[3], { action: "join", code: alphaCode })).status === 200, "P3 rejoins");
check((await team(P[1], { action: "rename", name: "Alpha Team" })).status === 200, "lead renames");
check((await team(P[2], { action: "rename", name: "Hijack" })).status === 403, "member can't rename");
check((await team(P[1], { action: "rename", name: "beta" })).status === 400, "rename to a taken name refused");

// Lead leaves: next member becomes lead; last member leaves: team is deleted.
r = await team(P[loser], { action: "create", name: "Solo" });
check(r.status === 200, `P${loser} creates Solo`);
check((await team(P[loser], { action: "leave" })).status === 200, "last member leaves");
check(!(await me(P[loser])).team, "empty team is gone");
r = await team(P[loser], { action: "create", name: "Gamma" });
const gammaCode = r.data?.joinCode;
check((await team(P[9], { action: "join", code: gammaCode })).status === 200, "P9 joins Gamma");

// Roster: once it's non-empty, only listed players get in.
check((await admin({ action: "rosterAdd", emails: [1, 2, 3, 4, 5, 6, 7, 9].map(ID).join(", ") })).data?.added === 8, "roster: 8 IDs added");
m = await me(P[8]);
check(m.allowed === false && !m.catalogue, "P8 (not on the roster) sees nothing", m);
check((await team(P[8], { action: "create", name: "Gatecrash" })).status === 403, "P8 can't create a team");
check((await call("/api/mystery/doc", undefined, P[8])).status === 403, "P8 can't read the case file");

// Nothing opens before the game.
check((await call("/api/mystery/open", { n: 1 }, P[1])).status === 409, "can't open before the game starts");

// ---- game on ----
await admin({ action: "stage", stage: "play" });
check((await team(P[8], { action: "join", code: alphaCode })).status !== 200, "teams locked");
check((await team(P[3], { action: "leave" })).status === 409, "can't leave once locked");
check((await call("/api/mystery/clue?n=3", undefined, P[1])).status === 403, "exhibit text is hidden until opened");
r = await call("/api/mystery/open", { n: 3 }, P[2]);
check(r.status === 403, "members can't open (lead only)", r.data);
r = await call("/api/mystery/open", { n: 3 }, P[1]);
check(r.status === 200 && r.data.count === 1 && !r.data.already, "lead opens 3: count 1", r.data);
r = await call("/api/mystery/open", { n: 3 }, P[1]);
check(r.status === 200 && r.data.count === 1 && r.data.already, "re-opening is free", r.data);
r = await call("/api/mystery/clue?n=3", undefined, P[3]);
check(r.status === 200 && r.data.clue.body.length > 100, "a teammate reads exhibit 3", r.status);
check((await call("/api/mystery/clue?n=3", undefined, P[4])).status === 403, "another team can't read it");
check((await call("/api/mystery/open", { n: 99 }, P[1])).status === 404, "no exhibit 99");
check((await call("/api/mystery/open", { n: "1; DROP TABLE teams" }, P[1])).status === 400, "junk exhibit number refused");
const both = await Promise.all([1, 4, 1, 4].map((n) => call("/api/mystery/open", { n }, P[1])));
check(both.every((x) => x.status === 200), "4 simultaneous opens all answer ok");
m = await me(P[2]);
check(m.opened.length === 3 && new Set(m.opened.map((o: any) => o.n)).size === 3, "simultaneous opens counted once each: 3", m.opened);
check(m.opened.every((o: any) => typeof o.by === "string"), "each open records who opened it");

await admin({ action: "settings", maxTeamSize: 3, unlockMode: "tap", openBy: "anyone" });
check((await call("/api/mystery/open", { n: 6 }, P[2])).data?.count === 4, "with 'any member', P2 opens 6: count 4");
await admin({ action: "settings", maxTeamSize: 3, unlockMode: "code", openBy: "lead" });
check((await call("/api/mystery/open", { n: 2 }, P[1])).status === 409, "code mode: tapping is refused");
const codes = (await call("/api/admin/mystery", undefined, A)).data.clues as { n: number; code: string }[];
const code2 = codes.find((c) => c.n === 2)!.code;
r = await call("/api/mystery/unlock", { code: `${code2.slice(0, 4).toLowerCase()} ${code2.slice(4)}` }, P[3]);
check(r.status === 200 && r.data.n === 2 && r.data.count === 5, "code mode: any member types a code: count 5", r.data);
last = 0;
// 30 wrong codes fired at once by one player: exactly 20 are checked, the rest refused (limit is per player, atomic)
const burst = await Promise.all(Array.from({ length: 30 }, () => call("/api/mystery/unlock", { code: "AAAA-AAAA" }, P[5])));
check(burst.filter((x) => x.status === 400).length === 20 && burst.filter((x) => x.status === 429).length === 10, "wrong exhibit codes: 20 per player per minute, even in a burst", burst.map((x) => x.status).join(""));
last = (await call("/api/mystery/unlock", { code: "AAAA-AAAA" }, P[5])).status;
check(last === 429, "wrong exhibit codes are rate-limited", last);
const mate = (await call("/api/mystery/unlock", { code: code2 }, P[3])).status;
check(mate === 200, "a teammate is NOT locked out by someone else's wrong codes", mate);
await admin({ action: "settings", maxTeamSize: 3, unlockMode: "tap", openBy: "lead" });

// Shared draft: lead writes, team reads.
check((await team(P[2], { action: "draft", draft: { q1: "member" } })).status === 403, "a member can't write the answer");
check((await team(P[1], { action: "draft", draft: { q1: "Aryan faked it", q2: "debt", q3: "" } })).status === 200, "lead's draft saves");
check((await me(P[3])).team.draft.q1 === "Aryan faked it", "teammates see the lead's draft");

// Submitting.
const ans = { q1: "Aryan Vardhan is alive; the body is someone else.", q2: "Rs 360 cr owed to Sethi.", q3: "Arvind Menon, Mumbai to Colombo, 9 Nov 11:40 PM." };
check((await call("/api/mystery/submit", { answers: ans }, P[1])).status === 409, "can't submit before submissions open");
await admin({ action: "submissions", open: true });
check((await call("/api/mystery/submit", { answers: ans }, P[2])).status === 403, "only the lead submits");
check((await call("/api/mystery/submit", { answers: { ...ans, q3: " " } }, P[1])).status === 400, "all three answers required");
check((await call("/api/mystery/submit", { answers: { ...ans, q1: "x".repeat(2001) } }, P[1])).status === 400, "over-long answer refused");
// Open and submit race: whichever lands second, the recorded count matches what's open.
const [o, s1] = await Promise.all([call("/api/mystery/open", { n: 8 }, P[1]), call("/api/mystery/submit", { answers: ans }, P[1])]);
check(s1.status === 200, "Alpha submits", s1.data);
m = await me(P[3]);
check(m.submission?.opened === m.opened.length, "recorded count equals what was open at submission", { sub: m.submission?.opened, open: m.opened.length, openStatus: o.status });
const alphaOpened = m.submission?.opened;
check((await call("/api/mystery/submit", { answers: ans }, P[1])).status === 409, "a second submission is refused");
check((await call("/api/mystery/open", { n: 9 }, P[1])).status === 409, "no opening after submitting");
check((await admin({ action: "unlockGrant", teamId: m.team.id, n: 9 })).status === 400, "admins can't grant after submission either");
check((await team(P[1], { action: "draft", draft: ans })).status === 403, "answer is frozen after submitting");

// Beta: lead double-taps submit.
for (const n of [1, 5]) await call("/api/mystery/open", { n }, P[4]);
const dbl = await Promise.all([1, 2, 3].map(() => call("/api/mystery/submit", { answers: ans }, P[4])));
check(dbl.filter((x) => x.status === 200).length === 1, "three simultaneous submits: exactly one stored", dbl.map((x) => x.status));
// Gamma: opens fewer, submits later.
for (const n of [1, 3, 6, 2]) await call("/api/mystery/open", { n }, P[loser]);
check((await call("/api/mystery/submit", { answers: ans }, P[loser])).status === 200, "Gamma submits (4 opened, latest)");

// ---- judging and results ----
let d = (await call("/api/admin/mystery", undefined, A)).data;
check(Object.keys(d.key.groups).length === 4 && Object.keys(d.key.needs).length === 6 && d.key.claims.length === 6, "answer key parsed: 4 groups, 6 claims", d.key);
const sub = (name: string) => d.submissions.find((s: any) => s.team.startsWith(name));
check(sub("Alpha").opened === alphaOpened && Array.isArray(sub("Alpha").openedList), "admin sees Alpha's opened count and list");
check((await call("/api/mystery/public")).data.results === null, "big screen shows no results before publishing");
check((await me(P[1])).results === null, "phones show no results before publishing");
await admin({ action: "judge", id: sub("Alpha").id, verdict: "correct", claims: [1, 2, 3, 4, 5, 6] });
await admin({ action: "judge", id: sub("Beta").id, verdict: "wrong", claims: [2] });
d = (await call("/api/admin/mystery", undefined, A)).data;
check(!d.standings.allJudged, "not final while Gamma is unjudged");
await admin({ action: "judge", id: sub("Gamma").id, verdict: "correct", claims: [1, 2, 3, 4, 5, 6] });
d = (await call("/api/admin/mystery", undefined, A)).data;
check(d.standings.allJudged && d.standings.rows[0].name === "Gamma" && d.standings.rows[1].name === "Alpha Team" && d.standings.rows[2].name === "Beta",
  "fewest opened wins: Gamma (4, later) beats Alpha; wrong answers last", d.standings.rows);
await admin({ action: "results", open: true });
const pub = (await call("/api/mystery/public")).data;
check(pub.results?.[0]?.name === "Gamma", "published: big screen shows Gamma first", pub);
check(!JSON.stringify(pub).includes("Aryan"), "big screen never shows answers");
const mine = (await me(P[9])).results;
check(mine?.[0]?.mine === true, "Gamma's phones see they won", mine);

// ---- end ----
await admin({ action: "stage", stage: "ended", confirm: "END" });
check((await call("/api/mystery/open", { n: 10 }, P[4])).status === 409, "ended: nothing opens");

// ---- organiser tools ----
await admin({ action: "reset", confirm: "RESET MYSTERY" });
await admin({ action: "stage", stage: "teams" });
r = await admin({ action: "teamsPaste", text: `Red: ${ID(1)}, ${ID(2)}\nBlue: ${ID(3)}, f19999999` });
check(r.status === 400 && /hasn't logged in/.test(r.data?.error), "paste with an unknown ID fails as a whole", r.data);
check((await me(P[1])).team === null, "...and nothing was created");
r = await admin({ action: "teamsPaste", text: `Red: ${ID(2)}, ${ID(1)}\nBlue: ${ID(3)} ${ID(4)} ${ID(5)}` });
check(r.status === 200 && r.data.added === 2, "paste two teams", r.data);
m = await me(P[1]);
check(m.team?.name === "Red" && m.team.leadId === m.team.members.find((x: any) => x.email.startsWith(ID(2)))?.id, "first ID is the lead", m.team);
r = await admin({ action: "teamsAuto", size: 2 });
check(r.status === 200, "random teams for the rest", r.data);
d = (await call("/api/admin/mystery", undefined, A)).data;
check(d.unassigned.length === 0 && d.teams.every((t: any) => t.leadId && t.members.some((x: any) => x.id === t.leadId)), "everyone placed; every team has a lead who is a member", d.unassigned);
const red = d.teams.find((t: any) => t.name === "Red");
const leadId = red.leadId;
await admin({ action: "teamRemoveMember", playerId: leadId });
d = (await call("/api/admin/mystery", undefined, A)).data;
const red2 = d.teams.find((t: any) => t.name === "Red");
check(red2.leadId && red2.leadId !== leadId && red2.members.some((x: any) => x.id === red2.leadId), "removing the lead promotes another member", red2);
r = await admin({ action: "rosterTop", count: 2, confirm: "2" });
check(r.status === 200 && r.data.added === 2, "rosterTop: top 2 of the guesstimate become the roster", r.data);
check((await admin({ action: "rosterTop", count: 2, confirm: "3" })).status === 400, "rosterTop needs the number typed back");

// ---- security basics ----
check((await call("/api/admin/mystery")).status === 401, "admin API needs the admin cookie");
check((await call("/api/admin/mystery", undefined, P[1])).status === 401, "a player token is not an admin");
check((await call("/api/admin/ranking", undefined, P[1])).status === 401, "ranking is admin-only");
check((await call("/api/mystery/team", { action: "create", name: "X" }, P[1], { origin: "https://evil.example" })).status === 400, "cross-site POST refused");
check((await call("/api/mystery/team", "action=create", P[1], { "content-type": "application/x-www-form-urlencoded" })).status === 400, "form POST refused");
check((await call("/api/mystery/me", undefined, { token: "forged" })).status === 401, "forged token refused");

// =====================================================================================
// Part 2: the default flow. Exhibits by code only, answers in person, organisers pick the number of teams.
// =====================================================================================
console.log("\n-- part 2: codes, answers in person, team count --");
await admin({ action: "reset", confirm: "RESET MYSTERY" });
await admin({ action: "rosterClear", confirm: "CLEAR" });
check((await admin({ action: "settings", maxTeamSize: 10, unlockMode: "code", openBy: "lead", answersOnline: false, maxTeams: 0 })).status === 200, "settings: code, answers in person");
check((await admin({ action: "settings", maxTeams: 2 })).status === 200, "settings: max teams 2 alone (other fields optional)");
d = (await call("/api/admin/mystery", undefined, A)).data;
check(d.mystery.max_teams === 2 && d.mystery.unlock_mode === "code" && d.mystery.answers_online === false && d.mystery.max_team_size === 10 && d.mystery.open_by === "lead",
  "partial settings keep the others; admin GET has the new settings", d.mystery);
for (const [bad, what] of [[{ maxTeams: 501 }, "501"], [{ maxTeams: -1 }, "-1"], [{ maxTeams: 1.5 }, "1.5"], [{ maxTeams: "x" }, "junk"], [{ answersOnline: "yes" }, "answersOnline as text"], [{ unlockMode: "magic" }, "bad unlock mode"]] as const)
  check((await admin({ action: "settings", ...bad })).status === 400, `settings refuse ${what}`);
check((await call("/api/admin/mystery", { action: "settings", answersOnline: true }, P[1])).status === 401, "players can't change settings");
check((await call("/api/mystery/public")).data.answersOnline === false, "public: answersOnline false");

await admin({ action: "stage", stage: "teams" });
m = await me(P[1]);
check(m.answersOnline === false && m.maxTeams === 2 && m.teamsMade === 0 && m.unlockMode === "code", "me: answersOnline, maxTeams, teamsMade", m);

// max_teams: five players create at once with room for two.
const race = await Promise.all([1, 2, 3, 4, 5].map((i) => team(P[i], { action: "create", name: `Racer ${i}` })));
const won = race.map((x, i) => (x.status === 200 ? i + 1 : 0)).filter(Boolean);
check(won.length === 2, "5 simultaneous creates with max 2 teams: exactly 2 made", race.map((x) => x.status));
check(race.filter((x) => x.status === 409 && /All 2 teams/.test(x.data?.error)).length === 3, "the other 3 get a clear 409", race.map((x) => x.data?.error));
check((await call("/api/admin/mystery", undefined, A)).data.teams.length === 2, "the database has exactly 2 teams");
check((await team(P[6], { action: "create", name: "Late" })).status === 409, "a 3rd team is refused later too");
check((await me(P[6])).teamsMade === 2, "players see 2 of 2 teams made");
const lost = [1, 2, 3, 4, 5].filter((i) => !won.includes(i));
const firstCode = (await me(P[won[0]])).team.joinCode;
check((await team(P[lost[0]], { action: "join", code: firstCode })).status === 200, "joining still works at the team limit");
check((await team(P[won[1]], { action: "leave" })).status === 200, "a team empties (its only member leaves)");
check((await team(P[6], { action: "create", name: "Team 1" })).status === 200, "...which frees a slot: P6 creates \"Team 1\"");
check((await admin({ action: "settings", maxTeams: 0 })).status === 200, "max teams back to 0 (no limit)");

// Random teams by number of teams.
d = (await call("/api/admin/mystery", undefined, A)).data;
const freeN: number = d.unassignedCount;
check(freeN >= 5, `${freeN} players without a team`, d.unassignedCount);
check((await admin({ action: "teamsAuto", teams: 0 })).status === 400, "random teams: 0 teams refused");
check((await admin({ action: "teamsAuto", teams: -3 })).status === 400, "random teams: negative refused");
check((await admin({ action: "teamsAuto", teams: "abc" })).status === 400, "random teams: junk refused");
r = await admin({ action: "teamsAuto", teams: freeN + 1 });
check(r.status === 400 && /at most/.test(r.data?.error), "random teams: more teams than people refused", r.data);
check((await call("/api/admin/mystery", undefined, A)).data.teams.length === 2, "...and nothing was created");
const before = new Set(d.teams.map((x: any) => x.id));
r = await admin({ action: "teamsAuto", teams: 4 });
check(r.status === 200 && r.data.added === 4 && r.data.people === freeN, `random teams: ${freeN} players into 4 teams`, r.data);
d = (await call("/api/admin/mystery", undefined, A)).data;
const made = d.teams.filter((x: any) => !before.has(x.id));
const sizes = made.map((x: any) => x.members.length);
check(made.length === 4 && Math.max(...sizes) - Math.min(...sizes) <= 1 && sizes.reduce((a: number, b: number) => a + b, 0) === freeN, "4 teams, sizes differ by at most 1, everyone placed once", sizes);
check(made.map((x: any) => x.name).sort().join(",") === "Team 2,Team 3,Team 4,Team 5", "named Team 2..5 (Team 1 was taken)", made.map((x: any) => x.name));
check(made.every((x: any) => x.leadId === x.members[0]?.id), "first member of each is the lead", made);
check(d.unassignedCount === 0, "nobody left without a team");
check((await admin({ action: "teamsAuto", teams: 1 })).status === 400, "random teams with nobody waiting refused");
check((await admin({ action: "answerGiven", teamId: made[0].id })).status === 409, "Answer given refused before the game");

// ---- game on: exhibits by code, answers in person ----
await admin({ action: "stage", stage: "play" });
const teamOfP = new Map<number, any>();
for (let i = 1; i <= 9; i++) teamOfP.set(i, (await me(P[i])).team);
// Pick three teams and one member of each (not the lead, to show any member can type a code).
const pick = (tid: number) => [...teamOfP.entries()].find(([, t]) => t?.id === tid)![0];
const tA = made[0], tB = made[1], tC = d.teams.find((x: any) => x.name === "Team 1"), tD = made[2];
const pA = pick(tA.id), pB = pick(tB.id), pC = pick(tC.id), pD = pick(tD.id);
check((await call("/api/mystery/open", { n: 1 }, P[pA])).status === 409, "code mode: tapping is refused");
const cl = (await call("/api/admin/mystery", undefined, A)).data.clues as { n: number; code: string }[];
const codeOf = (n: number) => cl.find((c) => c.n === n)!.code;
r = await call("/api/mystery/unlock", { code: codeOf(5).toLowerCase() }, P[pA]);
check(r.status === 200 && r.data.n === 5 && r.data.count === 1, "a member types a code: exhibit 5 opens, count 1", r.data);
const mateA = [...teamOfP.entries()].find(([i, t]) => t?.id === tA.id && i !== pA)?.[0] ?? pA;
check((await me(P[mateA])).opened.some((o: any) => o.n === 5), "teammates see it");
check((await call("/api/mystery/clue?n=5", undefined, P[mateA])).status === 200, "a teammate reads it");
check((await call("/api/mystery/clue?n=5", undefined, P[pB])).status === 403, "another team can't read it");
r = await call("/api/mystery/unlock", { code: codeOf(5) }, P[pA]);
check(r.status === 200 && r.data.already && r.data.count === 1, "same code again: already open, count stays", r.data);
r = await call("/api/mystery/unlock", { code: "QQQQ-QQQQ" }, P[pA]);
check(r.status === 400 && /No exhibit has that code/.test(r.data?.error), "wrong code: clear error", r.data);
check((await call("/api/mystery/unlock", { code: "ab" }, P[pA])).status === 400, "too-short code refused");
await call("/api/mystery/unlock", { code: codeOf(7) }, P[pA]);
await call("/api/mystery/unlock", { code: codeOf(2) }, P[pB]);
await call("/api/mystery/unlock", { code: codeOf(3) }, P[pC]);
await call("/api/mystery/unlock", { code: codeOf(4) }, P[pC]);
await call("/api/mystery/unlock", { code: codeOf(9) }, P[pD]);

// No answering on the website.
m = await me(P[pA]);
check(m.answersOnline === false && m.submission === null, "me: answers offline, nothing submitted");
r = await call("/api/mystery/submit", { answers: ans }, P[pA]);
check(r.status === 409 && /in person/.test(r.data?.error), "submit refused: answers are given in person", r.data);
await admin({ action: "submissions", open: true });
check((await call("/api/mystery/submit", { answers: ans }, P[pA])).status === 409, "...even with submissions open");
r = await team(P[pA], { action: "draft", draft: { q1: "x" } });
check(r.status === 409 && /in person/.test(r.data?.error), "draft refused too", r.data);

// Answer given (organisers), in order A, C, B, D.
r = await admin({ action: "answerGiven", teamId: tA.id });
check(r.status === 200 && r.data.opened === 2, "Answer given for A: records 2 opened", r.data);
r = await admin({ action: "answerGiven", teamId: tA.id });
check(r.status === 409 && /already answered/.test(r.data?.error), "Answer given twice refused", r.data);
check((await admin({ action: "answerGiven", teamId: 999999 })).status === 404, "Answer given for no such team: 404");
check((await call("/api/admin/mystery", { action: "answerGiven", teamId: tB.id }, P[pB])).status === 401, "players can't press Answer given");
m = await me(P[pA]);
check(m.submission?.opened === 2 && !!m.submission?.submittedAt, "A's phones see the answer recorded with 2 opened", m.submission);
r = await call("/api/mystery/unlock", { code: codeOf(8) }, P[pA]);
check(r.status === 409 && /given its answer/.test(r.data?.error), "A can't open more after answering", r.data);
check((await admin({ action: "unlockGrant", teamId: tA.id, n: 8 })).status === 400, "organisers can't grant after the answer either");
// C answers while an open is in flight: the recorded count is exactly what's open.
const [, ag] = await Promise.all([call("/api/mystery/unlock", { code: codeOf(6) }, P[pC]), admin({ action: "answerGiven", teamId: tC.id })]);
check(ag.status === 200, "Answer given for C", ag.data);
m = await me(P[pC]);
check(m.submission?.opened === m.opened.length, "C: recorded count equals what was open", { sub: m.submission?.opened, open: m.opened.length });
const cOpened: number = m.submission?.opened;
// Make C's count 2 for the tie test: if the in-flight open landed first (3), undo and re-record without it.
if (cOpened !== 2) {
  const sid = (await call("/api/admin/mystery", undefined, A)).data.submissions.find((x: any) => x.teamId === tC.id).id;
  await admin({ action: "deleteSubmission", id: sid, confirm: "DELETE" });
  await admin({ action: "unlockRevoke", teamId: tC.id, n: 6 });
  await admin({ action: "answerGiven", teamId: tC.id });
}
check((await admin({ action: "answerGiven", teamId: tB.id })).status === 200, "Answer given for B");
// Undo: D answers, organisers undo it, then D answers again (last, still 1 opened).
r = await admin({ action: "answerGiven", teamId: tD.id });
d = (await call("/api/admin/mystery", undefined, A)).data;
const subD = d.submissions.find((x: any) => x.teamId === tD.id);
check(subD?.inPerson === true && subD.by === null && subD.opened === 1 && JSON.stringify(subD.openedList) === "[9]", "admin sees D's in-person answer with its opened list", subD);
check(d.teams.find((x: any) => x.id === tD.id).answeredAt === subD.submittedAt, "live table: answered-at per team");
check((await admin({ action: "deleteSubmission", id: subD.id, confirm: "DELETE" })).status === 200, "undo D's answer");
check(!(await me(P[pD])).submission, "D's phones: no answer recorded");
r = await call("/api/mystery/unlock", { code: codeOf(9) }, P[pD]);
check(r.status === 200 && r.data.already, "D isn't blocked from codes after the undo", r.data);
check((await admin({ action: "answerGiven", teamId: tD.id })).status === 200, "D answers again (last)");

// Judging: A, C correct with 2 each (A first), D correct with 1 (last but fewest), B wrong.
d = (await call("/api/admin/mystery", undefined, A)).data;
const subOf = (tid: number) => d.submissions.find((x: any) => x.teamId === tid);
for (const [tm, v] of [[tA, "correct"], [tB, "wrong"], [tC, "correct"], [tD, "correct"]] as const)
  check((await admin({ action: "judge", id: subOf(tm.id).id, verdict: v, claims: [] })).status === 200, `judge ${tm.name} ${v} (no claims needed)`);
d = (await call("/api/admin/mystery", undefined, A)).data;
check(d.standings.allJudged && d.standings.rows.map((x: any) => x.teamId).join() === [tD.id, tA.id, tC.id, tB.id].join(),
  "standings: D (1 opened) > A (2, answered first) > C (2, later) > B (wrong)", d.standings.rows);
await admin({ action: "results", open: true });
check((await call("/api/mystery/public")).data.results?.[0]?.name === tD.name, "published: D first on the big screen");
check((await me(P[pD])).results?.[0]?.mine === true, "D's phones see they won");
await admin({ action: "stage", stage: "ended", confirm: "END" });
check((await call("/api/mystery/unlock", { code: codeOf(11) }, P[pB])).status === 409, "ended: codes don't open anything");

// Leave the database at the defaults.
await admin({ action: "settings", maxTeamSize: 10, unlockMode: "code", openBy: "lead", answersOnline: false, maxTeams: 0 });
await admin({ action: "reset", confirm: "RESET MYSTERY" });
await admin({ action: "rosterClear", confirm: "CLEAR" });
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
