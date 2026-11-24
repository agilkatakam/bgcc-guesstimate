"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, postJson, store, setToken } from "@/lib/client";
import { Markdown } from "@/lib/Markdown";

// Round 2 on a player's phone. Everyone in a team sees the same exhibits and case file.
// Exhibits open by default with a code an organiser hands the team (any member types it), or by tapping (option).
// Answers are given in person by default; with answersOnline the lead writes a shared draft and submits.

type Member = { id: number; name: string; email: string };
type Team = { id: number; name: string; leadId: number | null; joinCode: string | null; members: Member[]; draft: Record<string, string>; draftAt: string | null; draftBy: string | null };
type Result = { rank: number; name: string; opened: number; at: string; correct: boolean; mine: boolean };
export type MysteryMe = {
  ok: true; stage: "closed" | "teams" | "play" | "ended"; name: string; email: string; serverNow: number;
  answersOnline?: boolean; maxTeams?: number; teamsMade?: number | null;
  allowed?: boolean; playerId?: number; maxTeamSize?: number; unlockMode?: "tap" | "code"; openBy?: "lead" | "anyone";
  submissionsOpen?: boolean; team?: Team | null;
  catalogue?: { n: number; title: string; description: string }[];
  opened?: { n: number; at: string; by: string | null }[];
  submission?: { answers: Record<string, string>; submittedAt: string; by: string | null; opened: number | null } | null;
  results?: Result[] | null;
};

const QUESTIONS: [string, string][] = [
  ["q1", "1. What happened, and who was involved?"],
  ["q2", "2. Why did it happen?"],
  ["q3", "3. Where is the person responsible now headed, and how?"],
];
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });

/** Polls the player's round-2 view: every ~5 s while live, every ~30 s otherwise. */
export function useMystery(enabled: boolean) {
  const [me, setMe] = useState<MysteryMe | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    const r = await api<MysteryMe>("/api/mystery/me", {}, 5000);
    if (r.status === 401) { setToken(null); window.location.reload(); return false; } // logged out elsewhere: back to the login screen
    if (r.ok) setMe(r.data);
    return r.ok;
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const loop = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible") await refresh();
      const live = me === null || (me.stage !== "closed" && me.allowed !== false);
      timer.current = setTimeout(loop, live ? 4000 + Math.random() * 1500 : 30000 + Math.random() * 10000);
    };
    void loop();
    const wake = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refresh, me?.stage, me?.allowed]);
  return { me, refresh };
}

type Tab = "exhibits" | "case" | "answer" | "team";

export function Mystery({ me, refresh }: { me: MysteryMe; refresh: () => Promise<unknown> }) {
  const [tab, setTab] = useState<Tab>(() => (store.get("vc_tab") as Tab) || "exhibits");
  const [reading, setReadingRaw] = useState<number | null>(null);
  const listScroll = useRef(0);
  useEffect(() => store.set("vc_tab", tab), [tab]);
  // Open an exhibit at its top; coming back returns to the same place in the list.
  const setReading = useCallback((n: number | null) => {
    if (n !== null) listScroll.current = window.scrollY;
    setReadingRaw(n);
    requestAnimationFrame(() => window.scrollTo(0, n === null ? listScroll.current : 0));
  }, []);

  const team = me.team ?? null;
  const playing = me.stage === "play" || me.stage === "ended";

  if (!team) {
    if (me.stage === "teams") return <><Results me={me} /><JoinOrCreate me={me} refresh={refresh} /><Preview me={me} /></>;
    return (
      <section className="card hi">
        <h1>You&apos;re not in a team</h1>
        <p className="m0">Teams are locked. Find an organiser: they can add you to your team.</p>
      </section>
    );
  }

  if (me.stage === "teams")
    return <><TeamCard me={me} team={team} refresh={refresh} /><Preview me={me} /></>;

  if (reading !== null && playing) return <Reader n={reading} title={me.catalogue?.find((c) => c.n === reading)?.title ?? ""} onBack={() => setReading(null)} />;

  const count = me.opened?.length ?? 0;
  const online = !!me.answersOnline;
  const tabs: [Tab, React.ReactNode][] = [["exhibits", <>Exhibits <span className="count">{count}</span></>], ["case", "Case file"], ...(online ? [["answer", "Answer"] as [Tab, string]] : []), ["team", "Team"]];
  const shown: Tab = tab === "answer" && !online ? "exhibits" : tab;
  return (
    <>
      <Results me={me} />
      <Status me={me} team={team} count={count} />
      <nav className="tabs" role="tablist" style={online ? undefined : { gridTemplateColumns: "repeat(3, 1fr)" }}>
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={shown === k} className={shown === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      {shown === "exhibits" && <Exhibits me={me} team={team} refresh={refresh} onRead={setReading} />}
      {shown === "case" && <CaseFile />}
      {shown === "answer" && <Answer me={me} team={team} refresh={refresh} />}
      {shown === "team" && <TeamCard me={me} team={team} refresh={refresh} />}
    </>
  );
}

/** What a lead does, given the settings. */
const leadDuty = (me: MysteryMe) => {
  const opens = me.unlockMode === "tap" && me.openBy !== "anyone";
  const parts = [opens && "open exhibits", me.answersOnline && "submit the answer"].filter(Boolean);
  return parts.length
    ? `As lead you ${parts.join(" and ")} for everyone, so pick someone who'll stay with the team.`
    : "As lead you manage the team (name, members). Pick someone who'll stay with the team.";
};

const leadName = (team: Team) => team.members.find((m) => m.id === team.leadId)?.name ?? "your team lead";

/** How to answer when answers are given in person (the default). */
function InPersonRules({ className = "notice mt small" }: { className?: string }) {
  return (
    <div className={className}>
      <b>How to answer:</b> when your team is ready, tell the organisers your answer <b>in person</b>. Every different exhibit your team opened counts. Fewest exhibits with a correct answer wins; a tie goes to the team that answered first.
    </div>
  );
}

function Status({ me, team, count }: { me: MysteryMe; team: Team; count: number }) {
  const s = me.submission;
  const line = !me.answersOnline
    ? s ? `Answer given at ${time(s.submittedAt)} with ${s.opened ?? count} exhibit${(s.opened ?? count) === 1 ? "" : "s"} opened. No more opening.`
      : me.stage === "ended" ? "Time's up. Your team didn't give an answer."
      : "Ready? Tell an organiser your answer in person. Open only what you need."
    : s
    ? `Submitted at ${time(s.submittedAt)} with ${s.opened ?? count} exhibits opened. No more opening.`
    : me.stage === "ended" ? (me.results ? "Time's up. Your team didn't submit." : "Time's up. Your team didn't submit an answer.")
    : me.submissionsOpen ? "Submissions are open." : "Submissions open later. Read, think, open only what you need.";
  return (
    <section className={`card ${me.submission ? "" : "hi"}`}>
      <div className="row">
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow">{team.name}</p>
          <p className="m0 small">{line}</p>
          {!me.answersOnline && s && <p className="tag y mt">Answer given</p>}
        </div>
        <div className="center">
          <p className="big" aria-label={`${count} exhibits opened`}>{count}</p>
          <p className="eyebrow m0" style={{ color: "var(--muted)" }}>opened</p>
        </div>
      </div>
    </section>
  );
}

function Results({ me }: { me: MysteryMe }) {
  if (!me.results) return null;
  const r = me.results;
  const winner = r[0];
  const anyCorrect = r.some((x) => x.correct);
  return (
    <section className="card y">
      <p className="eyebrow" style={{ color: "#000" }}>Results</p>
      {winner ? <h1>{winner.mine ? "Your team won!" : `${winner.name} wins`}</h1> : <h1>No answers</h1>}
      {winner && <p className="m0">{winner.correct ? `Correct with ${winner.opened} exhibit${winner.opened === 1 ? "" : "s"} opened, at ${time(winner.at)}.` : "Nobody was fully correct; they got the most of the story right."}</p>}
      {!anyCorrect && r.length > 0 && <p className="small m0 mt">Ranked by how much of the story each team got right.</p>}
      <table className="mt"><thead><tr><th>#</th><th>Team</th><th className="n">Opened</th><th>Correct</th></tr></thead><tbody>
        {r.map((x) => <tr key={x.rank} style={x.mine ? { background: "#000", color: "var(--y)" } : undefined}><td>{x.rank}</td><td>{x.name}</td><td className="n">{x.opened}</td><td>{x.correct ? "Yes" : "No"}</td></tr>)}
      </tbody></table>
    </section>
  );
}

// ---------------- teams ----------------

function useAct(refresh: () => Promise<unknown>) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    const r = await postJson<Record<string, unknown>>(path, body);
    setBusy(false);
    if (r.status === 401) { setToken(null); window.location.reload(); return null; }
    if (!r.ok) setMsg(r.data?.error ?? "Couldn't reach the server. Try again.");
    await refresh();
    return r.ok ? r.data : null;
  }, [refresh]);
  return { msg, setMsg, busy, act };
}

function JoinOrCreate({ me, refresh }: { me: MysteryMe; refresh: () => Promise<unknown> }) {
  const [mode, setModeRaw] = useState<"join" | "create">("join");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const { msg, setMsg, busy, act } = useAct(refresh);
  const setMode = (m: "join" | "create") => { setModeRaw(m); setMsg(""); };
  return (
    <section className="card hi">
      <p className="eyebrow">Round 2 · The Vardhan Case</p>
      <h1>Get in a team</h1>
      <p>Teams of up to {me.maxTeamSize ?? 10}. One person creates the team and becomes its <b>lead</b>. Everyone else joins with the lead&apos;s code.</p>
      {!!me.maxTeams && me.teamsMade != null && (
        <p className={me.teamsMade >= me.maxTeams ? "notice small" : "small muted"}>
          {me.teamsMade >= me.maxTeams ? <>All <b>{me.maxTeams}</b> teams have been made. Ask around for a team&apos;s code and join it.</> : <>{me.teamsMade} of {me.maxTeams} teams made so far.</>}
        </p>
      )}
      <div className="tabs" style={{ gridTemplateColumns: "1fr 1fr", position: "static" }}>
        <button className={mode === "join" ? "on" : ""} onClick={() => setMode("join")}>Join a team</button>
        <button className={mode === "create" ? "on" : ""} onClick={() => setMode("create")}>Create (lead)</button>
      </div>
      {mode === "join" ? (
        <form onSubmit={(e) => { e.preventDefault(); void act("/api/mystery/team", { action: "join", code }); }}>
          <label>Team code from your lead
            <input className="code" value={code} maxLength={7} autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="5 letters" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          </label>
          {msg && <p className="err">{msg}</p>}
          <button className="primary" disabled={busy || code.length < 5}>{busy ? "Joining…" : "Join →"}</button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void act("/api/mystery/team", { action: "create", name }); }}>
          <label>Team name
            <input value={name} maxLength={30} placeholder="e.g. Baker Street" onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="muted small mt m0">{leadDuty(me)}</p>
          {msg && <p className="err">{msg}</p>}
          <button className="primary" disabled={busy || name.trim().length < 2}>{busy ? "Creating…" : "Create team →"}</button>
        </form>
      )}
    </section>
  );
}

function TeamCard({ me, team, refresh }: { me: MysteryMe; team: Team; refresh: () => Promise<unknown> }) {
  const { msg, busy, act } = useAct(refresh);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  const isLead = team.leadId === me.playerId;
  const forming = me.stage === "teams";
  const max = me.maxTeamSize ?? 10;
  return (
    <section className={`card ${forming ? "hi" : ""}`}>
      <p className="eyebrow">{isLead ? "You lead this team" : "Your team"}</p>
      {renaming ? (
        <form onSubmit={async (e) => { e.preventDefault(); if (await act("/api/mystery/team", { action: "rename", name })) setRenaming(false); }}>
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} aria-label="Team name" />
          <div className="btns mt"><button className="ghost y" disabled={busy}>Save name</button><button type="button" className="ghost" onClick={() => setRenaming(false)}>Cancel</button></div>
        </form>
      ) : (
        <div className="row"><h1 className="m0" style={{ overflowWrap: "anywhere" }}>{team.name}</h1>{isLead && forming && <button className="link" onClick={() => { setName(team.name); setRenaming(true); }}>Rename</button>}</div>
      )}
      {forming && team.joinCode && (
        <>
          <p className="mt m0">Teammates join with this code:</p>
          <div className="joincode" aria-label={`Team code ${team.joinCode.split("").join(" ")}`}>{team.joinCode}</div>
        </>
      )}
      <div className="row mt"><h3 className="m0">Members</h3><span className="tag line">{team.members.length} / {max}</span></div>
      <div>
        {team.members.map((m) => (
          <div className="person" key={m.id}>
            <span className="nm">{m.name}{m.id === me.playerId ? " (you)" : ""}<span className="id">{m.email.split("@")[0]}</span></span>
            {m.id === team.leadId && <span className="tag y">Lead</span>}
            {isLead && forming && m.id !== me.playerId && (
              <span className="acts">
                <button className="link" disabled={busy} onClick={() => { if (confirm(`Make ${m.name} the team lead? You won't be lead any more.`)) void act("/api/mystery/team", { action: "makeLead", playerId: m.id }); }}>Make lead</button>
                <button className="link" style={{ color: "var(--err)" }} disabled={busy} onClick={() => { if (confirm(`Remove ${m.name} from the team?`)) void act("/api/mystery/team", { action: "remove", playerId: m.id }); }}>Remove</button>
              </span>
            )}
          </div>
        ))}
      </div>
      {msg && <p className="err">{msg}</p>}
      {forming ? (
        confirmLeave ? (
          <div className="notice mt">
            <p>Leave {team.name}?{isLead && team.members.length > 1 ? " The next member becomes lead." : ""}</p>
            <div className="btns"><button className="ghost danger" disabled={busy} onClick={() => void act("/api/mystery/team", { action: "leave" })}>Yes, leave</button><button className="ghost" onClick={() => setConfirmLeave(false)}>Stay</button></div>
          </div>
        ) : <button className="ghost full" onClick={() => setConfirmLeave(true)}>Leave team</button>
      ) : <p className="muted small mt m0">Teams are locked. Organisers can still make changes.</p>}
      {forming && <p className="muted small mt m0">Teams lock when the game starts. This page updates by itself.</p>}
    </section>
  );
}

/** Exhibit titles and descriptions while teams form, so people can see what's coming. */
function Preview({ me }: { me: MysteryMe }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="card">
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : "Read"} the case file</button>
        {open && <div className="mt"><CaseFile bare /></div>}
      </section>
      {!!me.catalogue?.length && (
        <section className="card">
          <h3>The {me.catalogue.length} exhibits</h3>
          <p className="muted small">{me.unlockMode === "code" ? "During the game, ask an organiser for an exhibit's code; typing it opens the exhibit for your whole team. " : ""}Every exhibit your team opens counts. Fewest opened with a correct answer wins. A point only counts if your team has opened an exhibit that proves it.</p>
          {!me.answersOnline && <InPersonRules className="notice small m0" />}
          <ol className="small" style={{ paddingLeft: 22 }}>{me.catalogue.map((c) => <li key={c.n}><b>{c.title}</b> <span className="muted">{c.description}</span></li>)}</ol>
        </section>
      )}
    </>
  );
}

// ---------------- exhibits ----------------

function Exhibits({ me, team, refresh, onRead }: { me: MysteryMe; team: Team; refresh: () => Promise<unknown>; onRead: (n: number) => void }) {
  const [ask, setAsk] = useState<{ n: number; title: string } | null>(null);
  const [code, setCode] = useState("");
  const { msg, setMsg, busy, act } = useAct(refresh);
  const opened = new Map((me.opened ?? []).map((o) => [o.n, o]));
  const count = opened.size;
  const isLead = team.leadId === me.playerId;
  const live = me.stage === "play" && !me.submission;
  const tap = me.unlockMode !== "code";
  const canTap = live && tap && (me.openBy === "anyone" || isLead);

  async function open(n: number) {
    const r = await act("/api/mystery/open", { n });
    setAsk(null);
    if (r) onRead(n);
  }
  const [already, setAlready] = useState("");
  async function byCode(e: React.FormEvent) {
    e.preventDefault();
    setAlready("");
    const r = (await act("/api/mystery/unlock", { code })) as { n: number; title: string; already: boolean } | null;
    if (r) { setCode(""); if (r.already) setAlready(`Exhibit ${r.n} (${r.title}) was already open, so your count didn't change.`); else onRead(r.n); }
  }

  return (
    <>
      {live && !tap && (
        <form className="card hi" onSubmit={byCode}>
          <p className="eyebrow">Open an exhibit</p>
          <label htmlFor="excode" style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font)", fontSize: 17, color: "var(--ink)" }}>Type the code from your slip</label>
          <input id="excode" className="code" value={code} maxLength={12} inputMode="text" enterKeyHint="go" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="XXXX-XXXX"
            onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, "")); if (msg) setMsg(""); if (already) setAlready(""); }} />
          {msg && <p className="err" role="alert">{msg}</p>}
          {already && <p className="status ok" role="status">{already}</p>}
          <button className="primary" disabled={busy || code.replace(/[^A-Z0-9]/g, "").length < 4}>{busy ? "Checking…" : "Open exhibit"}</button>
          <p className="small muted mt m0">Want an exhibit? Ask an organiser for its code. Any teammate can type it: it opens for your whole team (on every phone within a few seconds) and adds 1 to your count.</p>
        </form>
      )}
      {!live && me.submission && !me.answersOnline && <div className="notice">Your team has given its answer, so no more exhibits can be opened. You can still read the ones you opened.</div>}
      {live && tap && !canTap && <div className="notice">Only your team lead, <b>{leadName(team)}</b>, can open exhibits. Opened ones appear here for everyone within a few seconds.</div>}
      {tap && msg && <p className="err" style={{ marginTop: 0, marginBottom: 12 }}>{msg}</p>}
      <ul className="exlist">
        {(me.catalogue ?? []).map((c) => {
          const o = opened.get(c.n);
          const state = o ? `Open · ${o.by ? `by ${o.by} · ` : ""}${time(o.at)} · tap to read` : canTap ? "Tap to open (+1)" : !live ? "Not opened" : tap ? `Not opened · ask ${leadName(team)}` : "Not opened · ask an organiser for its code";
          return (
            <li key={c.n}>
              <button className={`ex ${o ? "open" : "closed"}`} disabled={!o && !canTap} style={!o && !canTap ? { opacity: 1, cursor: "default" } : undefined}
                onClick={() => (o ? onRead(c.n) : canTap ? setAsk({ n: c.n, title: c.title }) : undefined)}>
                <span className="no">{String(c.n).padStart(2, "0")}</span>
                <span className="t">{c.title}</span>
                <span className="d">{c.description}</span>
                <span className="s">{state}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!me.answersOnline && <InPersonRules />}
      {ask && (
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ask-title" onClick={(e) => { if (e.target === e.currentTarget && !busy) setAsk(null); }}>
          <div className="card">
            <p className="eyebrow">Open exhibit {ask.n}?</p>
            <h2 id="ask-title">{ask.title}</h2>
            <p>Your team&apos;s count goes from <span className="hl">{count}</span> to <span className="hl">{count + 1}</span>. Everyone on your team can read it. You can&apos;t undo this.</p>
            {msg && <p className="err">{msg}</p>}
            <button className="primary" disabled={busy} onClick={() => void open(ask.n)}>{busy ? "Opening…" : `Open it (${count + 1})`}</button>
            <button className="ghost full" disabled={busy} onClick={() => { setAsk(null); setMsg(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

const clueCache = new Map<number, { title: string; description: string; body: string }>();

function Reader({ n, title, onBack }: { n: number; title: string; onBack: () => void }) {
  const [c, setC] = useState(clueCache.get(n) ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (clueCache.has(n)) return;
    let alive = true;
    const load = async () => {
      const r = await api<{ ok: true; clue: { title: string; description: string; body: string } }>(`/api/mystery/clue?n=${n}`, {}, 8000);
      if (!alive) return;
      if (r.ok) { clueCache.set(n, r.data.clue); setC(r.data.clue); setErr(""); }
      else { setErr(r.data?.error ?? "Couldn't load it. Retrying…"); if (!r.data?.error) setTimeout(load, 3000); }
    };
    void load();
    return () => { alive = false; };
  }, [n]);
  return (
    <article>
      <button className="ghost" onClick={onBack} style={{ marginBottom: 16 }}>← All exhibits</button>
      <section className="card">
        <p className="eyebrow">Exhibit {n}</p>
        <h2>{c?.title ?? title}</h2>
        {c && <p className="muted">{c.description}</p>}
        <div className="rule" />
        {err && <p className="err">{err}</p>}
        {c ? <div className="doc"><Markdown source={c.body} /></div> : !err && <p className="muted">Loading…</p>}
      </section>
      <button className="ghost full" onClick={onBack}>← All exhibits</button>
    </article>
  );
}

let caseCache: string | null = null;

function CaseFile({ bare = false }: { bare?: boolean }) {
  const [body, setBody] = useState<string | null>(caseCache);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (caseCache) return;
    let alive = true;
    const load = async () => {
      const r = await api<{ ok: true; body: string }>("/api/mystery/doc", {}, 8000);
      if (!alive) return;
      if (r.ok) { caseCache = r.data.body; setBody(r.data.body); setErr(""); }
      else { setErr(r.data?.error ?? "Couldn't load the case file. Retrying…"); setTimeout(load, 3000); }
    };
    void load();
    return () => { alive = false; };
  }, []);
  const inner = <>{err && <p className="err">{err}</p>}{body ? <div className="doc"><Markdown source={body} /></div> : !err && <p className="muted">Loading…</p>}</>;
  return bare ? inner : <section className="card">{inner}</section>;
}

// ---------------- answer ----------------

function Answer({ me, team, refresh }: { me: MysteryMe; team: Team; refresh: () => Promise<unknown> }) {
  const isLead = team.leadId === me.playerId;
  if (me.submission)
    return (
      <section className="card">
        <div className="card y" style={{ margin: "0 0 16px" }}>
          <h2 className="m0">✓ Submitted</h2>
          <p className="m0">{time(me.submission.submittedAt)}{me.submission.by ? ` by ${me.submission.by}` : ""} · {me.submission.opened ?? "—"} exhibits opened</p>
        </div>
        <h2>Your team&apos;s answer</h2>
        <p className="muted small">Exhibits opened when you submitted: <b>{me.submission.opened ?? "—"}</b>. Don&apos;t discuss the case outside your team until the reveal.</p>
        {QUESTIONS.map(([k, label]) => <div key={k}><h3 className="mt">{label}</h3><p style={{ whiteSpace: "pre-wrap" }}>{me.submission!.answers[k]}</p></div>)}
      </section>
    );
  if (!isLead)
    return (
      <section className="card">
        <p className="eyebrow">Live draft from {leadName(team)}</p>
        <h2>Your team&apos;s answer</h2>
        <p className="muted small">Only the lead writes and submits. This updates as they type{team.draftAt ? ` (last change ${time(team.draftAt)})` : ""}.</p>
        {QUESTIONS.map(([k, label]) => <div key={k}><h3 className="mt">{label}</h3><p style={{ whiteSpace: "pre-wrap" }} className={team.draft[k] ? "" : "muted"}>{team.draft[k] || "Nothing yet."}</p></div>)}
        <CaseRules />
      </section>
    );
  return <LeadAnswer me={me} team={team} refresh={refresh} />;
}

function CaseRules() {
  return (
    <div className="notice mt small">
      Be specific: name people, places, dates and times, and say which facts prove each point. Commit to one answer for each point. A point only counts if your team has opened an exhibit that proves it: guesses don&apos;t count, even if they&apos;re right.
    </div>
  );
}

function LeadAnswer({ me, team, refresh }: { me: MysteryMe; team: Team; refresh: () => Promise<unknown> }) {
  const local = `vc_draft_${team.id}`;
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    try { const s = JSON.parse(store.get(local) ?? "null"); if (s && typeof s === "object") return { ...team.draft, ...s }; } catch { /* ignore */ }
    return { ...team.draft };
  });
  const [saved, setSaved] = useState<"saved" | "saving" | "unsaved">("saved");
  const [ask, setAsk] = useState(false);
  const { msg, busy, act } = useAct(refresh);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const push = useCallback(async () => {
    setSaved("saving");
    const r = await postJson("/api/mystery/team", { action: "draft", draft: draftRef.current });
    if (r.ok) { setSaved("saved"); store.del(local); }
    else { setSaved("unsaved"); timer.current = setTimeout(() => void push(), 4000); }
  }, [local]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function change(k: string, v: string) {
    const next = { ...draftRef.current, [k]: v };
    setDraft(next);
    store.set(local, JSON.stringify(next));
    setSaved("unsaved");
    if (timer.current) clearTimeout(timer.current);
    if (me.stage === "play") timer.current = setTimeout(() => void push(), 1500);
  }

  const complete = QUESTIONS.every(([k]) => (draft[k] ?? "").trim().length > 0);
  const count = me.opened?.length ?? 0;
  return (
    <section className="card">
      <p className="eyebrow">You&apos;re the lead · your team sees this as you type</p>
      <h2>Your team&apos;s answer</h2>
      {QUESTIONS.map(([k, label]) => (
        <label key={k} style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font)", fontSize: 16, color: "var(--ink)" }}>{label}
          <textarea value={draft[k] ?? ""} maxLength={2000} onChange={(e) => change(k, e.target.value)} disabled={me.stage !== "play"} />
        </label>
      ))}
      <p className={`status ${saved === "unsaved" ? "err" : saved === "saved" ? "ok" : "muted"}`}>{saved === "saved" ? "✓ Saved for your team" : saved === "saving" ? "Saving…" : "Not saved yet (kept on this phone)"}</p>
      <CaseRules />
      {msg && <p className="err">{msg}</p>}
      <button className="primary" disabled={!me.submissionsOpen || !complete || busy} onClick={() => setAsk(true)}>
        {me.stage === "ended" ? "Time's up" : me.submissionsOpen ? (complete ? "Submit for the team →" : "Answer all three to submit") : "Submissions aren't open yet"}
      </button>
      {ask && (
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sub-title" onClick={(e) => { if (e.target === e.currentTarget && !busy) setAsk(false); }}>
          <div className="card">
            <p className="eyebrow">One submission per team</p>
            <h2 id="sub-title">Submit for {team.name}?</h2>
            <p>Exhibits opened: <span className="hl">{count}</span>. After this your team can&apos;t open more exhibits or change the answer. Your submission time breaks ties.</p>
            {msg && <p className="err">{msg}</p>}
            <button className="primary" disabled={busy} onClick={async () => { if (await act("/api/mystery/submit", { answers: draftRef.current })) { setAsk(false); store.del(local); } }}>{busy ? "Submitting…" : "Yes, submit"}</button>
            <button className="ghost full" disabled={busy} onClick={() => setAsk(false)}>Not yet</button>
          </div>
        </div>
      )}
    </section>
  );
}
