"use client";
import { useCallback, useEffect, useState } from "react";
import { api, postJson, noteClock, serverNow, store } from "@/lib/client";
import { formatIndian } from "@/lib/parse";
import { DEFAULT_BANDS, describeBands, type Bands } from "@/lib/scoring";
import { MysteryAdmin } from "./MysteryAdmin";

type Q = { idx: number; kind: string; practice: boolean; text: string; unit: string; low: number | null; high: number | null; answer: number | null; weight: number; section: string; seconds: number; reveal_seconds: number; note: string; label: string };
type AdminState = {
  ok: true; admin: string; version: number; label: string | null; qualifyCount: number; revealedUpTo: number; serverNow: number; scoring: Bands; lobbyNote: string;
  state: { phase: string; index: number | null; opensAt: number | null; closesAt: number | null; revealAt: number | null; revealEndsAt: number | null; paused: boolean; nextChangeAt: number | null };
  game: { mode: string; maxRevealedIndex: number };
  questions: Q[];
  counts: { players: number; sessions: number; multi: number; answered: number };
  recent: { at: string; admin: string; action: string; detail: unknown }[];
};
type PlayerRow = { id: number; email: string; name: string | null; disqualified: boolean; sessions: number; answers: number };
type Tab = "guess" | "qualify" | "round2" | "players";
type Say = (m: string) => void;

const ist = (iso: string | number) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });

export default function Admin() {
  const [s, setS] = useState<AdminState | null>(null);
  const [need, setNeed] = useState(false);
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState<Tab>(() => (store.get("admin_tab") as Tab) || "guess");
  const [, tick] = useState(0);
  useEffect(() => store.set("admin_tab", tab), [tab]);

  const refresh = useCallback(async () => {
    const r = await api<AdminState>("/api/admin/state", {}, 5000);
    if (r.ok) { noteClock(r.data.serverNow, r.t0, r.t1); setS(r.data); setNeed(false); }
    else if (r.status === 401) setNeed(true);
  }, []);

  useEffect(() => {
    void refresh();
    const a = setInterval(refresh, 2000);
    const b = setInterval(() => tick((x) => x + 1), 250);
    return () => { clearInterval(a); clearInterval(b); };
  }, [refresh]);

  if (need) return <main className="wrap"><AdminLogin onDone={refresh} /></main>;
  if (!s) return <main className="wrap"><p className="muted mt">Loading…</p></main>;

  async function act(action: string, extra: Record<string, unknown> = {}, ask?: string) {
    let confirm: string | undefined;
    if (ask) {
      const v = prompt(ask);
      if (v === null) return false;
      confirm = v;
    }
    const r = await postJson<{ ok: true; version?: number }>("/api/admin/action", { action, version: s!.version, confirm, ...extra });
    // use the new version straight away, so a quick second tap isn't refused as "someone else changed the game"
    if (r.ok && r.data.version) setS((prev) => (prev ? { ...prev, version: r.data.version! } : prev));
    setMsg(r.ok ? `${action}: done` : `${action}: ${r.data?.error ?? "network error, try again"}`);
    void refresh();
    return r.ok;
  }

  const st = s.state;
  const left = (t: number | null) => (t == null ? "" : `${Math.max(0, Math.ceil((t - serverNow()) / 1000))}s`);
  const tabs: [Tab, string][] = [["guess", "Guesstimate"], ["qualify", "Qualifiers"], ["round2", "Round 2"], ["players", "Players"]];

  return (
    <main className="wrap wide admin">
      <header className="bar">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo" src="/logo.png" alt="BGCC: BITS Goa Consulting Club" width={104} height={40} />
        <span className="title"><small>Organisers</small>Admin</span>
        <span className="who">{s.admin} · {ist(s.serverNow)} IST · <a href="/screen" target="_blank">Big screen ↗</a></span>
      </header>
      <nav className="tabs" style={{ top: 71 }}>
        {tabs.map(([k, label]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>)}
      </nav>
      {msg && <div className="notice msg row"><span>{msg}</span><button className="link" onClick={() => setMsg("")}>Dismiss</button></div>}

      {tab === "guess" && (
        <>
          <section className="card">
            <p className="eyebrow">Guesstimate · {s.game.mode}{st.paused ? " · PAUSED" : ""}</p>
            <h2 className="m0">{st.phase === "countdown" ? `Countdown · first question opens in ${left(st.opensAt)}` : <>{s.label ?? (s.game.mode === "lobby" ? "Lobby" : st.phase)}</>}{st.phase === "open" ? ` · closes in ${left(st.closesAt)}` : st.phase === "reveal" ? ` · next in ${left(st.revealEndsAt)}` : ""}</h2>
            <p className="muted small mt">Players {s.counts.players} · answered this round {s.counts.answered} · devices {s.counts.sessions} · on 2+ devices {s.counts.multi}</p>
            <div className="btns">
              {s.game.mode === "lobby" && <button className="go" onClick={() => act("start", { countdown: 10 }, "Every phone shows a 10-second countdown, then question 1 opens. Type START")}>Start (10 s countdown)</button>}
              {!st.paused && s.game.mode === "running" && <button onClick={() => act("pause")}>Pause</button>}
              {st.paused && <button className="go" onClick={() => act("resume")}>Resume</button>}
              {st.phase === "open" && <><button onClick={() => act("extend", { seconds: 15 })}>+15 s answer</button><button onClick={() => act("extend", { seconds: 30 })}>+30 s answer</button></>}
              {st.phase === "reveal" && <button onClick={() => act("extendReveal", { seconds: 30 })}>+30 s reveal</button>}
              {s.game.mode === "running" && <button className="danger" onClick={() => act("finish", {}, `End the guesstimate now?${st.phase === "open" || st.phase === "closing" ? ` The current round (${s.label}) will NOT be scored.` : ""} Type FINISH`)}>Finish</button>}
              <a href="/api/admin/export"><button>Download results CSV</button></a>
            </div>
          </section>
          {s.game.mode === "lobby" && <LobbyNote note={s.lobbyNote} act={act} />}
          <section className="card">
            <h3>Questions</h3>
            <p className="small muted m0">{s.scoring.lowerWins === false && <>Max possible: {s.questions.filter((x) => x.kind === "q" && !x.practice).reduce((t, x) => t + x.weight, 0) * Math.max(s.scoring.inside, s.scoring.steps[0]?.[1] ?? 0)} points. </>}Tap an answer to change it (everyone is rescored).</p>
            <div className="tablewrap"><table>
              <thead><tr><th>#</th><th>Question</th><th>Answer</th></tr></thead>
              <tbody>
                {s.questions.map((x) => (
                  <QRow key={x.idx} x={x} current={st.index === x.idx} revealed={x.idx <= s.revealedUpTo} finished={s.game.mode === "finished"} onJump={() => act("jump", { item: x.idx }, `Jump to item ${x.idx} and open it NOW? Type ${x.idx} to confirm`)} onSaved={refresh} setMsg={setMsg} />
                ))}
              </tbody>
            </table></div>
            {s.questions.length === 0 && <p className="err">No questions loaded. Run: node scripts/manage.ts questions questions.csv</p>}
          </section>
          <Scoring bands={s.scoring} act={act} />
          <section className="card">
            <h3>Dry runs</h3>
            <button className="danger" onClick={() => act("reset", {}, "Dry runs only. Deletes ALL guesstimate answers and returns to the lobby. Type RESET EVERYTHING")}>Reset guesstimate</button>
          </section>
        </>
      )}
      {tab === "qualify" && <Qualifiers setMsg={setMsg} act={act} />}
      {tab === "round2" && <MysteryAdmin setMsg={setMsg} />}
      {tab === "players" && (
        <>
          <Players setMsg={setMsg} />
          <section className="card">
            <h3>Recent admin actions</h3>
            {s.recent.map((r, i) => <p key={i} className="small muted m0">{ist(r.at)} {r.admin}: {r.action} {r.detail ? JSON.stringify(r.detail).slice(0, 160) : ""}</p>)}
          </section>
        </>
      )}
    </main>
  );
}

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  return (
    <form className="card hi mt" onSubmit={async (e) => {
      e.preventDefault();
      const r = await postJson<{ ok: true }>("/api/admin/login", { name, password });
      if (r.ok) onDone(); else setErr(r.data?.error ?? "Network error");
    }}>
      <p className="eyebrow">Organisers</p>
      <h1>Admin login</h1>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
      {err && <p className="err">{err}</p>}
      <button className="primary">Log in</button>
    </form>
  );
}

function QRow({ x, current, revealed, finished, onJump, onSaved, setMsg }: { x: Q; current: boolean; revealed: boolean; finished: boolean; onJump: () => void; onSaved: () => void; setMsg: Say }) {
  const [edit, setEdit] = useState(false);
  const exact = x.low === x.high;
  const [answer, setAnswer] = useState(String(x.answer ?? (exact ? x.low ?? "" : "")));
  const [weight, setWeight] = useState(String(x.weight));
  async function save() {
    const a = Number(answer.replace(/[,\s]/g, "")), w = Number(weight);
    if (!(a > 0) || !(w > 0)) return setMsg("Answer and weight must be numbers above 0");
    if (!confirm(`Item ${x.idx}: answer ${formatIndian(a)}, weight ${w}×? Everyone is rescored.`)) return;
    const body: Record<string, unknown> = { idx: x.idx, answer: a, weight: w };
    if (exact) { body.low = a; body.high = a; }
    const r = await postJson<{ ok: true }>("/api/admin/questions", body);
    setMsg(r.ok ? `item ${x.idx} saved` : r.data?.error ?? "network error");
    if (r.ok) { setEdit(false); onSaved(); }
  }
  return (
    <tr className={current ? "me" : ""}>
      <td>{x.idx}<br /><span className="small">{x.label}</span>{!revealed && !current && !finished && <><br /><button className="mt" onClick={onJump}>Open now</button></>}</td>
      <td>{x.text}<br /><span className="small muted">{x.unit ? `${x.unit} · ` : ""}{x.seconds}s · reveal {x.reveal_seconds}s{x.kind === "q" ? ` · ${x.weight}× points` : ""}{revealed ? " · revealed" : ""}</span></td>
      <td>
        {x.kind === "q" && (edit
          ? <><label className="small">Answer<input inputMode="decimal" value={answer} onChange={(e) => setAnswer(e.target.value)} /></label><label className="small">Weight<input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label><div className="btns mt"><button onClick={save}>Save</button><button onClick={() => setEdit(false)}>Cancel</button></div></>
          : <button className="link" onClick={() => setEdit(true)} title="Edit answer">{x.answer !== null ? formatIndian(x.answer) : ""}{!exact ? ` (${formatIndian(x.low!)} – ${formatIndian(x.high!)})` : x.answer === null ? formatIndian(x.low!) : ""}</button>)}
      </td>
    </tr>
  );
}

function LobbyNote({ note, act }: { note: string; act: (a: string, e?: Record<string, unknown>) => Promise<boolean> }) {
  const [text, setText] = useState(note);
  useEffect(() => setText(note), [note]);
  return (
    <section className="card">
      <h3>Lobby message</h3>
      <p className="small muted m0">Big text on every phone and the projector before the start, above a live clock.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void act("lobbyNote", { note: text }); }}>
        <input maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="Starts around 5:10 to 5:15 PM" />
        <button style={{ marginTop: 6 }}>Save</button>
      </form>
    </section>
  );
}

function Scoring({ bands, act }: { bands: Bands; act: (a: string, e?: Record<string, unknown>) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [edit, setEdit] = useState(false);
  return (
    <section className="card">
      <h3>Scoring rubric</h3>
      <table className="small" style={{ maxWidth: 420 }}><tbody>
        {describeBands(bands).map(([label, pts]) => <tr key={label}><td>{label}</td><td className="n">{pts}</td></tr>)}
        <tr><td>Ranking</td><td className="n">{bands.lowerWins === false ? "highest total first" : "lowest total first"}</td></tr>
      </tbody></table>
      {edit ? (
        <>
          <p className="small muted mt">JSON. <b>steps</b> are [times, points]: within that many times of the answer. Each question&apos;s weight multiplies these. Saving rescores everyone, even mid-game.</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
          <div className="btns mt">
            <button className="go" onClick={async () => { if (confirm("Save this rubric and rescore everyone?") && (await act("scoring", { scoring: text }))) setEdit(false); }}>Save rubric</button>
            <button onClick={() => setText(JSON.stringify(DEFAULT_BANDS, null, 1))}>Load default</button>
            <button onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </>
      ) : <button className="mt" onClick={() => { setText(JSON.stringify(bands, null, 1)); setEdit(true); }}>Edit rubric</button>}
    </section>
  );
}

type RankRow = { rank: number; eligible_rank: number | null; name: string; email: string; total: number; blanks: number; eligible: boolean; on_roster: boolean };
type Ranking = { ok: true; ready: boolean; through: string | null; finished: boolean; qualifyCount: number; qualifyAnnounced: boolean; rosterCount: number; rows: RankRow[] };

function Qualifiers({ setMsg, act }: { setMsg: Say; act: (a: string, e?: Record<string, unknown>, ask?: string) => Promise<boolean> }) {
  const [d, setD] = useState<Ranking | null>(null);
  const [x, setX] = useState("");
  const load = useCallback(async () => {
    const r = await api<Ranking>("/api/admin/ranking", {}, 15000);
    if (r.ok) { setD(r.data); setX((v) => v || (r.data.qualifyCount ? String(r.data.qualifyCount) : "")); }
  }, []);
  useEffect(() => { void load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, [load]);
  if (!d) return <section className="card"><p className="muted">Loading ranking…</p></section>;
  const n = Math.trunc(Number(x)) || 0;
  const eligible = d.rows.filter((r) => r.eligible);
  const atCut = n > 0 ? eligible[n - 1] : undefined;
  const after = n > 0 ? eligible[n] : undefined;
  const tie = atCut && after && atCut.total === after.total;
  return (
    <>
      <section className="card hi">
        <p className="eyebrow">Decide on the spot</p>
        <h2>Who goes to Round 2?</h2>
        <p className="small muted">{d.finished ? "The guesstimate is finished." : `Ranking through ${d.through ?? "—"} (the guesstimate is still running).`} {eligible.length} eligible players. Current cut-off: {d.qualifyCount || "not decided"} · roster now {d.rosterCount}.</p>
        <label>Top how many?<input inputMode="numeric" value={x} onChange={(e) => setX(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 40" style={{ maxWidth: 200 }} /></label>
        {n > 0 && atCut && <p className="mt">Cut at <b>#{n} {atCut.name}</b> ({atCut.total}). {after ? <>Next: #{n + 1} {after.name} ({after.total}).</> : "Everyone qualifies."}</p>}
        {tie && <p className="notice">Tie on score at the cut-off. It&apos;s settled by the tie-breaks (fewer blanks, closeness, speed); both are shown in order below.</p>}
        <button className="primary" disabled={!(n > 0 && n <= eligible.length)} onClick={async () => {
          const v = prompt(`Replace the Round 2 roster with the top ${n}? Players don't see it until you press Announce. Type ${n}`);
          if (v === null) return;
          const r = await postJson<{ ok: true; added: number }>("/api/admin/mystery", { action: "rosterTop", count: n, confirm: v });
          setMsg(r.ok ? `Roster: ${r.data.added} qualifiers (not announced yet). Press Announce when you're ready.` : r.data?.error ?? "network error");
          if (r.ok) void load();
        }}>Set top {n || "N"} as qualifiers</button>
        <div className="rule" />
        <p className="m0"><b>{d.qualifyAnnounced ? `Announced: phones and the projector show the top ${d.qualifyCount}.` : d.qualifyCount ? `Top ${d.qualifyCount} set, NOT announced yet. Phones still say "Results are in".` : "Not set yet."}</b></p>
        {d.qualifyCount > 0 && !d.qualifyAnnounced && <button className="go mt" onClick={async () => { if (await act("announce", {}, `Show "You're through" on the top ${d.qualifyCount} phones and the cut line on every screen? Type ANNOUNCE`)) void load(); }}>Announce top {d.qualifyCount}</button>}
        {d.qualifyAnnounced && <button className="mt" onClick={async () => { if (confirm("Hide the cut again?") && (await act("announce", { confirm: "no" }))) void load(); }}>Hide again</button>}
      </section>
      <section className="card">
        <h3>Ranking</h3>
        <div className="scroll"><table>
          <thead><tr><th className="n">#</th><th>Name</th><th>ID</th><th className="n">Total</th><th className="n">Blanks</th><th></th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.email} className={`${r.eligible_rank !== null && n > 0 && r.eligible_rank <= n ? "in" : ""} ${r.eligible_rank === n ? "cut" : ""}`}>
                <td className="n">{r.eligible_rank ?? "—"}</td><td>{r.name}</td><td className="mono small">{r.email.split("@")[0]}</td>
                <td className="n">{r.total}</td><td className="n">{r.blanks}</td>
                <td className="small">{!r.eligible ? "not eligible" : r.on_roster ? "in Round 2" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {!d.rows.length && <p className="muted">No ranking yet. It appears after the first scored round is revealed.</p>}
      </section>
    </>
  );
}

function Players({ setMsg }: { setMsg: Say }) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<PlayerRow[]>([]);
  async function search() {
    const r = await api<{ ok: true; rows: PlayerRow[] }>(`/api/admin/players?q=${encodeURIComponent(term)}`);
    if (r.ok) setRows(r.data.rows);
  }
  async function act(id: number, action: string) {
    let pin: string | undefined;
    if (action === "resetPin") {
      const v = prompt("Check their BITS ID card first. New 4-digit PIN to give them:");
      if (!v) return;
      pin = v;
    } else if (action === "rename") {
      const v = prompt("New name (shown on the leaderboard):");
      if (!v) return;
      const r = await postJson<{ ok: true }>("/api/admin/players", { id, action, name: v });
      setMsg(r.ok ? "renamed" : r.data?.error ?? "network error");
      return void search();
    } else if (!confirm(`${action} player ${id}?`)) return;
    const r = await postJson<{ ok: true }>("/api/admin/players", { id, action, pin });
    setMsg(r.ok ? `${action} done` : r.data?.error ?? "network error");
    void search();
  }
  return (
    <section className="card">
      <h3>Players</h3>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input placeholder="Search ID, email or name" value={term} onChange={(e) => setTerm(e.target.value)} />
        <button style={{ marginTop: 6 }}>Search</button>
      </form>
      <div className="tablewrap"><table><tbody>
        {rows.map((p) => (
          <tr key={p.id}>
            <td>{p.name ?? "—"}<br /><span className="mono small muted">{p.email}</span><br /><span className="small muted">{p.answers} answers · {p.sessions} devices{p.disqualified ? " · DISQUALIFIED" : ""}</span></td>
            <td><div className="btns">
              <button onClick={() => act(p.id, "resetPin")}>Reset PIN</button>
              <button onClick={() => act(p.id, "rename")}>Rename</button>
              <button className={p.disqualified ? "" : "danger"} onClick={() => act(p.id, p.disqualified ? "reinstate" : "disqualify")}>{p.disqualified ? "Reinstate" : "Disqualify"}</button>
              <button onClick={() => act(p.id, "logout")}>Log out devices</button>
            </div></td>
          </tr>
        ))}
      </tbody></table></div>
    </section>
  );
}
