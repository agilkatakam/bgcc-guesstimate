"use client";
import { useCallback, useEffect, useState } from "react";
import { api, postJson } from "@/lib/client";

type Member = { id: number; name: string; email: string };
type Team = {
  id: number; name: string; leadId: number | null; joinCode: string | null; submitted: boolean; submissionId: number | null; answeredAt: string | null;
  members: Member[]; opened: { n: number; at: string; by: string | null }[];
};
type Sub = {
  id: number; teamId: number; team: string; answers: Record<string, string>; inPerson: boolean; submittedAt: string; opened: number | null; openedList: number[] | null;
  verdict: "correct" | "wrong" | null; claims: number[] | null; note: string | null; judgedBy: string | null; by: string | null;
};
type Standing = { teamId: number; name: string; submittedAt: string; opened: number; verdict: string | null; claims: number; rank: number };
type Data = {
  ok: true;
  mystery: { stage: string; submissions_open: boolean; max_team_size: number; unlock_mode: "tap" | "code"; open_by: "lead" | "anyone"; results_public: boolean; answers_online: boolean; max_teams: number };
  roster: { email: string; name: string | null; joined: boolean; team: string | null }[];
  teams: Team[];
  unassigned: { id: number; email: string; name: string | null }[];
  unassignedCount: number;
  clues: { n: number; title: string; code: string; teams: number }[];
  submissions: Sub[];
  key: { groups: Record<string, number[]>; needs: Record<number, string[]>; claims: string[] };
  standings: { rows: Standing[]; allJudged: boolean };
};
type Act = (action: string, extra?: Record<string, unknown>, ask?: string) => Promise<boolean>;

const QLABELS: [string, string][] = [["q1", "1. What happened, and who was involved?"], ["q2", "2. Why did it happen?"], ["q3", "3. Where is the person responsible now headed, and how?"]];
const t = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });
const fmtCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const id = (email: string) => email.split("@")[0];

export function MysteryAdmin({ setMsg }: { setMsg: (m: string) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const refresh = useCallback(async () => {
    const r = await api<Data>("/api/admin/mystery", {}, 8000);
    if (r.ok) setD(r.data);
  }, []);
  useEffect(() => {
    void refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, [refresh]);

  const act: Act = useCallback(async (action, extra = {}, ask) => {
    let confirm: string | undefined;
    if (ask) {
      const v = prompt(ask);
      if (v === null) return false;
      confirm = v;
    }
    const r = await postJson<{ ok: true; added?: number }>("/api/admin/mystery", { action, confirm, ...extra });
    setMsg(r.ok ? `${action}: done${r.data.added !== undefined ? ` (${r.data.added})` : ""}` : `${action}: ${r.data?.error ?? "network error"}`);
    await refresh();
    return r.ok;
  }, [refresh, setMsg]);

  if (!d) return <section className="card"><p className="muted">Loading…</p></section>;
  const m = d.mystery;
  const stages: [string, string][] = [["closed", "Closed"], ["teams", "Team forming"], ["play", "Game on"], ["ended", "Ended"]];
  const online = m.answers_online;
  const help: Record<string, string> = {
    closed: "Players see the guesstimate. Nothing about Round 2 is visible.",
    teams: `Qualifiers create teams (creator = lead) and join with the lead's 5-letter code${m.max_teams ? ` (at most ${m.max_teams} teams)` : ""}. They can read the case file and exhibit titles. Nothing can be opened yet.`,
    play: `Teams lock. ${m.unlock_mode === "code" ? "Hand out exhibit codes when teams ask." : "Exhibits can be opened."} ${online ? "Open submissions when you're ready; each team's lead submits once." : "When a team tells you its answer, press Answer given for that team (below)."}`,
    ended: online ? "Nothing more can be opened or submitted. Judge, then announce the winner." : "Nothing more can be opened. Record any last answers, judge, then announce the winner.",
  };

  return (
    <>
      <section className="card hi">
        <p className="eyebrow">Round 2 · The Vardhan Case</p>
        <div className="stagebar">
          {stages.map(([k, label]) => (
            <button key={k} className={m.stage === k ? "on" : ""} disabled={m.stage === k} onClick={() => {
              const open = d.teams.filter((x) => !x.submitted).length;
              if (k === "ended") return act("stage", { stage: k }, `End Round 2 for everyone? No more opening${online ? " or submitting" : ""}.${open ? ` ${open} team${open === 1 ? " hasn't" : "s haven't"} ${online ? "submitted; their drafts won't count" : "given an answer yet"}.` : ""} Type END`);
              if (confirm(`Switch every phone to "${label}"?\n\n${help[k]}`)) void act("stage", { stage: k });
            }}>{label}</button>
          ))}
        </div>
        <p className="small mt">{help[m.stage]}</p>
        <div className="btns">
          {online && <button className={m.submissions_open ? "go" : ""} disabled={m.stage !== "play"} onClick={() => act("submissions", { open: !m.submissions_open })}>
            Submissions {m.submissions_open ? "OPEN · close" : "closed · open"}
          </button>}
          {/* Round 2 standings are announced live, never on screens; this only shows if someone published by mistake */}
          {m.results_public && <button className={m.results_public ? "go" : ""} onClick={() => act("results", { open: !m.results_public }, m.results_public ? undefined : `Show the standings on the big screen and every phone? ${d.standings.allJudged ? "" : "NOT every submission is judged yet. "}Type YES`)}>
            Results {m.results_public ? "PUBLIC · hide" : "hidden · publish"}
          </button>}
        </div>
        <Settings m={m} act={act} />
      </section>

      <Live d={d} act={act} />
      <Judging d={d} act={act} />
      <Teams d={d} act={act} />
      <Roster d={d} act={act} />

      <section className="card">
        <h3>Exhibits</h3>
        <p className="small muted">{m.unlock_mode === "code" ? "Code mode: give a team the code for the exhibit they ask for. Codes ignore case, spaces and dashes." : "Tap mode: teams open exhibits themselves. Codes still work if you hand one out."} Every team that opens an exhibit adds 1 to its own count.</p>
        <div className="tablewrap"><table>
          <thead><tr><th>#</th><th>Title</th><th>Code</th><th className="n">Teams opened</th></tr></thead>
          <tbody>{d.clues.map((c) => <tr key={c.n}><td>{c.n}</td><td>{c.title}</td><td className="mono">{fmtCode(c.code)}</td><td className="n">{c.teams}</td></tr>)}</tbody>
        </table></div>
        {d.clues.length === 0 && <p className="err">No exhibits loaded. Run: node scripts/manage.ts mystery</p>}
      </section>

      <section className="card">
        <h3>Dry runs</h3>
        <button className="danger" onClick={() => act("reset", {}, "Deletes all teams, opened exhibits and submissions, and closes Round 2. Type RESET MYSTERY")}>Reset Round 2</button>
      </section>
    </>
  );
}

function Settings({ m, act }: { m: Data["mystery"]; act: Act }) {
  const [size, setSize] = useState(String(m.max_team_size));
  const [maxTeams, setMaxTeams] = useState(String(m.max_teams));
  const save = (patch: Record<string, unknown>) => act("settings", patch);
  return (
    <>
      <div className="btns mt" style={{ alignItems: "center" }}>
        <span className="small">Max team size</span>
        <input value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, ""))} style={{ width: 70, marginTop: 0 }} inputMode="numeric" aria-label="Max team size" />
        <button onClick={() => save({ maxTeamSize: Number(size) })}>Save</button>
        <span className="small" style={{ marginLeft: 12 }}>Max teams players can create</span>
        <input value={maxTeams} onChange={(e) => setMaxTeams(e.target.value.replace(/\D/g, ""))} style={{ width: 70, marginTop: 0 }} inputMode="numeric" aria-label="Max teams" />
        <button onClick={() => save({ maxTeams: Number(maxTeams || 0) })}>Save</button>
        <span className="small muted">{m.max_teams ? `now ${m.max_teams}` : "now: no limit"} (0 = no limit)</span>
      </div>
      <div className="btns mt" style={{ alignItems: "center" }}>
        <span className="small">Open exhibits by</span>
        <button className={m.unlock_mode === "code" ? "go" : ""} onClick={() => save({ unlockMode: "code" })}>Code from us</button>
        <button className={m.unlock_mode === "tap" ? "go" : ""} onClick={() => save({ unlockMode: "tap" })}>Tap</button>
        {m.unlock_mode === "tap" && <>
          <span className="small" style={{ marginLeft: 12 }}>Who can tap</span>
          <button className={m.open_by === "lead" ? "go" : ""} onClick={() => save({ openBy: "lead" })}>Lead only</button>
          <button className={m.open_by === "anyone" ? "go" : ""} onClick={() => save({ openBy: "anyone" })}>Any member</button>
        </>}
      </div>
      <div className="btns mt" style={{ alignItems: "center" }}>
        <span className="small">Answers</span>
        <button className={!m.answers_online ? "go" : ""} onClick={() => save({ answersOnline: false })}>In person</button>
        <button className={m.answers_online ? "go" : ""} onClick={() => { if (confirm("Switch to answers on the website? Leads will see an Answer tab, write a draft and submit (when you open submissions).")) void save({ answersOnline: true }); }}>On the website</button>
      </div>
    </>
  );
}

// ---------------- live: what each team has opened, and when it answered ----------------

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function Live({ d, act }: { d: Data; act: Act }) {
  const m = d.mystery;
  const canRecord = m.stage === "play" || m.stage === "ended";
  const teams = [...d.teams].sort(byName);
  const answered = teams.filter((x) => x.submitted).length;
  return (
    <section className="card">
      <div className="row"><h3 className="m0">Live: teams and clues</h3><span className="tag line">{answered} of {teams.length} answered</span></div>
      <p className="small muted mt">
        Cross-check with what you handed out. {m.answers_online
          ? "Answers come in on the website; Answer given records one for a team whose phone failed (empty answer)."
          : <>When a team tells you its answer, press <b>Answer given</b> straight away: that moment breaks ties, and the team can&apos;t open more. Undo deletes it.</>}
      </p>
      {teams.length === 0 ? <p className="muted">No teams yet.</p> : (
        <div className="tablewrap"><table>
          <thead><tr><th></th><th>Team</th><th>Clues opened</th><th>Members</th><th>First / last open</th><th>Answered</th></tr></thead>
          <tbody>{teams.map((tm) => {
            const list = [...tm.opened].sort((a, b) => a.n - b.n).map((o) => o.n);
            const first = tm.opened[0]?.at, last = tm.opened[tm.opened.length - 1]?.at;
            return (
              <tr key={tm.id}>
                <td>{tm.submitted ? (
                  <button className="link" onClick={() => act("deleteSubmission", { id: tm.submissionId }, `Undo ${tm.name}'s answer (and any verdict on it)? They can open exhibits again. Type DELETE`)}>Undo</button>
                ) : (
                  <button className="go" disabled={!canRecord} title={canRecord ? "" : "Start the game first"} onClick={() => {
                    if (confirm(`${tm.name} gave its answer in person, now?\n\nRecords this moment and ${list.length} exhibit${list.length === 1 ? "" : "s"} opened${list.length ? ` (${list.join(", ")})` : ""}. The team can't open more.`)) void act("answerGiven", { teamId: tm.id });
                  }}>Answer given</button>
                )}</td>
                <td style={{ minWidth: "8em" }}><b style={{ overflowWrap: "break-word" }}>{tm.name}</b></td>
                <td><b className="mono">{list.length}</b>{list.length > 0 && <span className="small"> · {list.join(", ")}</span>}</td>
                <td><b className="mono">{tm.members.length}</b><br /><span className="small muted">{tm.members.map((p) => p.name).join(", ") || "—"}</span></td>
                <td className="mono small">{first ? <>{t(first)}<br />{t(last)}</> : "—"}</td>
                <td className="mono small">{tm.answeredAt ? <b>{t(tm.answeredAt)}</b> : "—"}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

// ---------------- judging ----------------

function groupsOpened(key: Data["key"], list: number[]) {
  return new Set(Object.entries(key.groups).filter(([, ns]) => ns.some((n) => list.includes(n))).map(([g]) => g));
}

function Judging({ d, act }: { d: Data; act: Act }) {
  const order = new Map(d.standings.rows.map((r) => [r.teamId, r.rank]));
  const subs = [...d.submissions].sort((a, b) => (order.get(a.teamId) ?? 0) - (order.get(b.teamId) ?? 0));
  const pending = d.submissions.filter((s) => !s.verdict).length;
  return (
    <section className="card">
      <div className="row"><h3 className="m0">{d.mystery.answers_online ? "Submissions" : "Answers given"} ({subs.length})</h3><span className={`tag ${pending ? "y" : "line"}`}>{pending ? `${pending} to judge` : "all judged"}</span></div>
      <p className="small muted mt">Shown in ranking order: correct answers first (fewest exhibits, then earliest), then the rest (most claims, fewest exhibits, earliest). Judge from the top. A claim can only be ticked if the team opened every exhibit group it needs (the answer key&apos;s rule); blocked claims are struck through.{d.mystery.answers_online ? "" : " Answers given in person: mark Correct / Not correct; claims are optional (they only rank teams if nobody is correct)."}</p>
      {d.standings.rows.length > 0 && (
        <div className="tablewrap"><table>
          <thead><tr><th>#</th><th>Team</th><th className="n">Opened</th><th>Submitted</th><th>Verdict</th><th className="n">Claims</th></tr></thead>
          <tbody>{d.standings.rows.map((r) => <tr key={r.teamId} className={r.rank === 1 && d.standings.allJudged ? "me" : ""}><td>{r.rank}</td><td>{r.name}</td><td className="n">{r.opened}</td><td>{t(r.submittedAt)}</td><td>{r.verdict ?? "—"}</td><td className="n">{r.claims}</td></tr>)}</tbody>
        </table></div>
      )}
      {subs.length === 0 && <p className="muted">None yet.</p>}
      {subs.map((s) => <Judge key={s.id} s={s} keyInfo={d.key} act={act} online={d.mystery.answers_online} />)}
    </section>
  );
}

function Judge({ s, keyInfo, act, online }: { s: Sub; keyInfo: Data["key"]; act: Act; online: boolean }) {
  const [ticks, setTicks] = useState<number[]>(s.claims ?? []);
  const [note, setNote] = useState(s.note ?? "");
  const list = s.openedList ?? [];
  const have = groupsOpened(keyInfo, list);
  const allowed = (i: number) => (keyInfo.needs[i] ?? []).every((g) => have.has(g));
  const n = keyInfo.claims.length;
  const all = n > 0 && keyInfo.claims.every((_, i) => ticks.includes(i + 1) && allowed(i + 1));
  // In person there's no written answer to tick claims against: Correct needs no ticks.
  const canCorrect = s.inPerson || all;
  const claims = (
    <div>
      {keyInfo.claims.map((c, i) => {
        const ok = allowed(i + 1);
        const needs = keyInfo.needs[i + 1] ?? [];
        return (
          <label key={i} className={`claim ${ok ? "" : "blocked"}`}>
            <input type="checkbox" disabled={!ok} checked={ticks.includes(i + 1) && ok}
              onChange={(e) => setTicks(e.target.checked ? [...ticks, i + 1] : ticks.filter((x) => x !== i + 1))} />
            <span><b>{i + 1}</b>{needs.length ? ` [needs ${needs.join("+")}${ok ? "" : ": NOT OPENED"}]` : ""} {c}</span>
          </label>
        );
      })}
    </div>
  );
  return (
    <div className={`judge ${s.verdict === null ? "pending" : s.verdict}`}>
      <div className="row">
        <b>{s.team}</b>
        <span className="small muted">{t(s.submittedAt)} · {s.inPerson ? "in person" : `by ${s.by ?? "?"}`} · {s.verdict ? `${s.verdict.toUpperCase()} (${s.judgedBy})` : "NOT JUDGED"}</span>
      </div>
      <p className="small mt m0">Opened <b>{s.opened ?? list.length}</b>: {list.join(", ") || "none"} · groups {[...have].sort().join(" ") || "none"} of {Object.keys(keyInfo.groups).sort().join(" ")}</p>
      {s.inPerson ? (
        <>
          <p className="small mt m0">Answer given in person. Check it against the answer key and the groups opened above.</p>
          <details className="mt"><summary className="small">Claims ({ticks.filter(allowed).length} ticked, optional: only used if nobody is correct)</summary>{claims}</details>
        </>
      ) : (
        <>
          {QLABELS.map(([k, label]) => <div key={k}><p className="small muted m0 mt">{label}</p><div className="ans">{s.answers[k]}</div></div>)}
          {claims}
        </>
      )}
      <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="btns mt">
        <button className="go" disabled={!canCorrect} title={canCorrect ? "" : "Tick every claim first"} onClick={() => act("judge", { id: s.id, verdict: "correct", claims: ticks.filter(allowed), note })}>Correct</button>
        <button className="danger" onClick={() => act("judge", { id: s.id, verdict: "wrong", claims: ticks.filter(allowed), note })}>Not correct</button>
        {s.verdict && <button onClick={() => act("judge", { id: s.id, verdict: null, claims: ticks.filter(allowed), note })}>Undo verdict</button>}
        <button className="danger" onClick={() => act("deleteSubmission", { id: s.id }, s.inPerson ? `Undo ${s.team}'s answer (and its verdict)? They can open exhibits again. Type DELETE` : `Delete ${s.team}'s submission so they can submit again? Type DELETE`)}>{s.inPerson ? "Undo answer" : "Delete"}</button>
      </div>
    </div>
  );
}

// ---------------- teams ----------------

function Teams({ d, act }: { d: Data; act: Act }) {
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const [paste, setPaste] = useState("");
  const [nTeams, setNTeams] = useState("");
  return (
    <section className="card">
      <div className="row"><h3 className="m0">Teams ({d.teams.length})</h3><span className="tag line">{d.unassignedCount} not in a team</span></div>
      <div className="grid2 mt">
        {d.teams.map((tm) => <TeamBox key={tm.id} tm={tm} d={d} act={act} />)}
      </div>
      {d.unassigned.length > 0 && (
        <div className="notice mt small"><b>Not in a team:</b> {d.unassigned.map((p) => `${p.name ?? id(p.email)} (${id(p.email)})`).join(" · ")}{d.unassignedCount > d.unassigned.length ? ` · and ${d.unassignedCount - d.unassigned.length} more` : ""}</div>
      )}
      <div className="grid2 mt">
        <form onSubmit={async (e) => { e.preventDefault(); if (await act("teamCreate", { name, lead })) { setName(""); setLead(""); } }}>
          <h3>Create a team</h3>
          <input placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Lead's BITS ID (optional)" value={lead} onChange={(e) => setLead(e.target.value)} />
          <button className="mt">Create</button>
        </form>
        <form onSubmit={async (e) => { e.preventDefault(); if (await act("teamsPaste", { text: paste })) setPaste(""); }}>
          <h3>Paste teams</h3>
          <p className="small muted m0">One team per line. The first ID is the lead. Moves people out of other teams. All or nothing.</p>
          <textarea placeholder={"Baker Street: f20260001, f20260002, f20260003\nScotland Yard: f20260004, f20260005"} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button className="mt">Create these teams</button>
        </form>
        <RandomTeams free={d.unassignedCount} n={nTeams} setN={setNTeams} act={act} />
      </div>
    </section>
  );
}

/** "38 players → 6 teams of 6–7" */
function split(people: number, teams: number) {
  const lo = Math.floor(people / teams), hi = Math.ceil(people / teams);
  return `${people} player${people === 1 ? "" : "s"} → ${teams} team${teams === 1 ? "" : "s"} of ${lo === hi ? lo : `${lo}–${hi}`}`;
}

function RandomTeams({ free, n, setN, act }: { free: number; n: string; setN: (v: string) => void; act: Act }) {
  const k = Number(n);
  const valid = Number.isInteger(k) && k >= 1 && k <= free;
  const preview = !n ? (free ? `${free} without a team. How many teams?` : "Nobody is waiting for a team.")
    : k < 1 ? "At least 1 team." : k > free ? `Only ${free} without a team: at most ${free} team${free === 1 ? "" : "s"}.` : split(free, k);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!valid || !confirm(`Make random teams?\n\n${split(free, k)}.\nEveryone on the list who has logged in and isn't in a team. Named Team 1, Team 2, …; the first of each team is lead.`)) return;
      if (await act("teamsAuto", { teams: k })) setN("");
    }}>
      <h3>Random teams</h3>
      <p className="small muted m0">Everyone on the list who has logged in and isn&apos;t in a team, shuffled. Sizes differ by at most 1. The first of each team is lead (change it below).</p>
      <div className="btns mt" style={{ alignItems: "center" }}>
        <input value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ""))} style={{ width: 80, marginTop: 0 }} inputMode="numeric" aria-label="Number of teams" placeholder="N" />
        <span className="small">teams</span>
      </div>
      <p className={`small mt m0 ${valid ? "" : "muted"}`}><b>{preview}</b></p>
      <button className="mt" disabled={!valid}>Make {valid ? k : ""} random teams</button>
    </form>
  );
}

function TeamBox({ tm, d, act }: { tm: Team; d: Data; act: Act }) {
  const opened = new Set(tm.opened.map((o) => o.n));
  return (
    <div className="judge" style={{ margin: 0 }}>
      <div className="row">
        <b style={{ overflowWrap: "anywhere" }}>{tm.name}</b>
        <span className="mono small">{tm.joinCode}</span>
      </div>
      <p className="small muted m0">{tm.members.length}/{d.mystery.max_team_size} people · {opened.size} opened{tm.submitted ? (d.mystery.answers_online ? " · SUBMITTED" : " · ANSWERED") : ""}</p>
      {tm.members.map((p) => (
        <div className="person" key={p.id} style={{ padding: "6px 0" }}>
          <span className="nm small">{p.name}<span className="id">{id(p.email)}</span></span>
          {p.id === tm.leadId ? <span className="tag y">Lead</span> : <button className="link" onClick={() => act("teamLead", { teamId: tm.id, playerId: p.id })}>Make lead</button>}
          <button className="link" style={{ color: "var(--err)" }} onClick={() => { if (confirm(`Remove ${p.name} from ${tm.name}?`)) void act("teamRemoveMember", { playerId: p.id }); }}>Remove</button>
        </div>
      ))}
      <p className="small m0 mt">Exhibits (tap to grant/revoke; counts):</p>
      <div className="exgrid">{d.clues.map((c) => {
        const has = opened.has(c.n);
        const o = tm.opened.find((x) => x.n === c.n);
        return <button key={c.n} className={has ? "on" : ""} title={o ? `${o.by ?? "organiser"} at ${t(o.at)}` : "Grant"} disabled={tm.submitted}
          onClick={() => { if (confirm(`${has ? "Revoke" : "Grant"} exhibit ${c.n} ${has ? "from" : "to"} ${tm.name}? ${has ? "Their count drops by 1." : "Their count goes up by 1."}`)) void act(has ? "unlockRevoke" : "unlockGrant", { teamId: tm.id, n: c.n }); }}>{c.n}</button>;
      })}</div>
      <div className="btns mt">
        <button onClick={() => { const e = prompt(`Add to ${tm.name}: BITS ID (moves them from any other team; they must have logged in once)`); if (e) void act("teamAddMember", { teamId: tm.id, email: e }); }}>Add</button>
        <button onClick={() => { const n = prompt("New name", tm.name); if (n) void act("teamRename", { teamId: tm.id, name: n }); }}>Rename</button>
        <button className="danger" onClick={() => act("teamDelete", { teamId: tm.id }, `Delete ${tm.name} (and its opened exhibits and submission)? Type DELETE`)}>Delete</button>
      </div>
    </div>
  );
}

function Roster({ d, act }: { d: Data; act: Act }) {
  const [emails, setEmails] = useState("");
  const [show, setShow] = useState(false);
  return (
    <section className="card">
      <h3>Who can play Round 2 ({d.roster.length === 0 ? "anyone logged in" : `${d.roster.length} on the list`})</h3>
      <p className="small muted">Set this from the Qualifiers tab (top N of the guesstimate), or add IDs by hand. Empty list = anyone who logs in.</p>
      <form onSubmit={async (e) => { e.preventDefault(); if (await act("rosterAdd", { emails })) setEmails(""); }}>
        <textarea rows={2} placeholder="Add BITS IDs or emails (comma, space or one per line)" value={emails} onChange={(e) => setEmails(e.target.value)} />
        <div className="btns mt">
          <button>Add to list</button>
          {d.roster.length > 0 && <button type="button" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"} list</button>}
          {d.roster.length > 0 && <button type="button" className="danger" onClick={() => act("rosterClear", {}, "Empty the list (then anyone logged in can play)? Type CLEAR")}>Clear list</button>}
        </div>
      </form>
      {show && (
        <div className="scroll mt"><table><tbody>
          {d.roster.map((r) => (
            <tr key={r.email}>
              <td>{r.name ?? "—"}<br /><span className="mono small muted">{id(r.email)}{r.joined ? "" : " · hasn't logged in"}{r.team ? ` · ${r.team}` : ""}</span></td>
              <td><button className="link" onClick={() => act("rosterRemove", { email: r.email })}>Remove</button></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </section>
  );
}
