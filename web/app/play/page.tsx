"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, postJson, getToken, setToken, noteClock, serverNow, nextSeq, readQueue, writeQueue, beaconSave, isInAppBrowser,
  type PublicState,
} from "@/lib/client";
import { useGameState, useNow } from "@/lib/useGameState";
import { parseAnswer, formatIndian, inWords } from "@/lib/parse";
import { describeBands, lowerWins, type Bands } from "@/lib/scoring";
import { Mystery, useMystery } from "./Mystery";
import { Calc } from "./Calc";

type MeItem = { idx: number; label: string; practice: boolean; value: number | null; seq: number; revealed: boolean; penalty: number | null; weight: number; section: string; range: { low: number; high: number; answer: number | null } | null };
type Plan = { section: string; count: number; seconds: number; weight: number }[];
type Me = { ok: true; playerId: number; name: string; disqualified: boolean; items: MeItem[]; total: number; rank: number | null; eligibleRank: number | null; players: number | null; pending?: boolean; qualifyCount: number; scoring: Bands; plan: Plan; serverNow: number };
type Board = { ready: boolean; through: string | null; players: number; qualifyCount: number; top: { pid?: number; rank: number; name: string; total: number; eligible: boolean; eligible_rank: number | null }[] };
type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; value: number } | { kind: "unsaved"; why: string } | { kind: "closed" } | { kind: "error"; why: string };

const fmt = (n: number | null | undefined) => (n == null ? "—" : formatIndian(n));
/** The model answer: the stored answer, or the band when it is a single number. */
const answerOf = (r: { low: number; high: number; answer?: number | null } | null) => (r ? r.answer ?? (r.low === r.high ? r.low : null) : null);
const ist = (ms: number, sec = true) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}), timeZone: "Asia/Kolkata" });
const mmss = (s: number) => (s % 60 === 0 ? `${s / 60} min` : s > 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min` : `${s} s`);

export default function Play() {
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [playerId, setPlayerId] = useState<number | null>(null);
  const { state, offline } = useGameState(1000);
  const mysteryLive = !!state?.mystery && state.mystery !== "closed";
  const { me: mystery, refresh: refreshMystery } = useMystery(authed === true && mysteryLive);

  const refreshMe = useCallback(async () => {
    const r = await api<Me>("/api/me");
    if (r.ok) {
      noteClock(r.data.serverNow, r.t0, r.t1);
      setMe(r.data);
      setPlayerId(r.data.playerId);
      setAuthed(true);
    } else if (r.status === 401) {
      setToken(null);
      setAuthed(false);
    } else if (authed === null) {
      // Server unreachable on first load: show the shell (with the offline banner) and keep trying.
      setTimeout(() => void refreshMe(), 3000);
    }
  }, [authed]);

  useEffect(() => {
    void refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The ranking was still being computed when we asked: ask again in 1.5–3.5 s.
  useEffect(() => {
    if (!me?.pending) return;
    const t = setTimeout(() => void refreshMe(), 1500 + Math.random() * 2000);
    return () => clearTimeout(t);
  }, [me, refreshMe]);

  // After each reveal / results, refresh scores with jitter so 500 phones don't hit at once.
  const lastPhase = useRef("");
  useEffect(() => {
    if (!state || !authed) return;
    // the key changes on every phase change AND every admin action (announce, rename…), so phones pick those up
    const tag = state.key;
    if (tag === lastPhase.current) return;
    lastPhase.current = tag;
    if (state.phase === "reveal" || state.phase === "results" || state.phase === "lobby") {
      const t = setTimeout(() => void refreshMe(), Math.random() * 3000);
      return () => clearTimeout(t);
    }
  }, [state, authed, refreshMe]);

  if (authed === null) return <Shell offline={offline}><p className="muted center mt">Loading…</p></Shell>;
  if (!authed)
    return (
      <Shell offline={offline}>
        <Login onDone={(pid) => { setPlayerId(pid); void refreshMe(); }} />
      </Shell>
    );

  const logout = () => { setToken(null); setAuthed(false); setMe(null); };
  if (mysteryLive && mystery && mystery.stage !== "closed" && mystery.allowed !== false)
    return (
      <Shell title="The Vardhan Case" name={mystery.name} onLogout={logout} offline={offline}>
        <Mystery me={mystery} refresh={refreshMystery} />
      </Shell>
    );

  return (
    <Shell name={me?.name} onLogout={logout} offline={offline}>
      {mysteryLive && mystery?.allowed === false && <div className="notice">Round 2 is for the qualifiers. Thanks for playing!</div>}
      {!state ? <p className="muted">Connecting…</p> : <Game state={state} me={me} playerId={playerId} onAuthLost={() => { setToken(null); setAuthed(false); }} />}
    </Shell>
  );
}

function Shell({ children, name, onLogout, offline, title = "Guesstimate" }: { children: React.ReactNode; name?: string; onLogout?: () => void; offline?: boolean; title?: string }) {
  return (
    <main className="wrap">
      <header className="bar">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo" src="/logo.png" alt="BGCC: BITS Goa Consulting Club" width={104} height={40} />
        <span className="title"><small>BGCC · Pre-induction</small>{title}</span>
        {name && (
          <span className="who">
            <span className="whoname">{name}</span>
            {onLogout && <button className="link" onClick={() => { if (confirm("Log out? You'll need your PIN to get back in.")) onLogout(); }}>Log out</button>}
          </span>
        )}
      </header>
      {offline && <div className="banner bad">Can&apos;t reach the server. On campus Wi-Fi? Its sign-in page may have expired: open any website to sign in to the Wi-Fi again, or switch to mobile data. Don&apos;t log out. Nothing you typed is lost.</div>}
      {children}
    </main>
  );
}

function Login({ onDone }: { onDone: (playerId: number) => void }) {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(isInAppBrowser()), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    type LoginOk = { ok: true; token: string; playerId: number; name: string; first: boolean };
    let r = await postJson<LoginOk & { confirmNew?: boolean }>("/api/login", { email, pin, name, check: true });
    if (!r.ok && r.data?.confirmNew) {
      const id = email.trim().split("@")[0].toUpperCase();
      if (!confirm(`First time? This creates a NEW account for ${id}.\n\nIf you've logged in before, your BITS ID is mistyped: press Cancel and check it.`)) { setBusy(false); return; }
      r = await postJson<LoginOk & { confirmNew?: boolean }>("/api/login", { email, pin, name });
    }
    setBusy(false);
    if (r.ok) {
      setToken(r.data.token);
      onDone(r.data.playerId);
    } else setErr(r.data?.error ?? "Couldn't reach the server. Check your connection and try again.");
  }

  return (
    <form className="card hi" onSubmit={submit}>
      {inApp && <div className="banner">You&apos;re inside an app&apos;s browser. Open this link in Chrome or Safari so you don&apos;t get logged out.</div>}
      <p className="eyebrow">BITS Goa · Pre-induction</p>
      <h1>Log in</h1>
      <label>BITS ID
        <input autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="f20260123" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>Your name <span className="muted small">(shown on the leaderboard)</span>
        <input autoComplete="name" autoCapitalize="words" maxLength={40} placeholder="First and last name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>4-digit PIN
        <input type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required />
      </label>
      <p className="muted small mt m0">First time? Choose any 4 digits and remember them. Coming back? Your BITS ID and the same PIN are enough; the name is only needed the first time.</p>
      {err && <p className="err">{err}</p>}
      <button className="primary" disabled={busy}>{busy ? "Checking…" : "Enter →"}</button>
    </form>
  );
}

function Game({ state, me, playerId, onAuthLost }: { state: PublicState; me: Me | null; playerId: number | null; onAuthLost: () => void }) {
  const now = useNow();
  const left = (t: number | null) => (t == null ? 0 : Math.max(0, Math.ceil((t - now) / 1000)));

  if (state.phase === "lobby") return <Lobby me={me} note={state.lobbyNote} now={now} />;
  if (state.phase === "countdown") return <Countdown state={state} me={me} secs={left(state.opensAt)} />;
  if (state.phase === "results") return <Results me={me} />;

  const myItem = me?.items.find((i) => i.idx === state.index);

  if (state.kind === "break") {
    return (
      <section className="card hi center">
        <span className="tag y">Break</span>
        <h2 className="mt">{state.text}</h2>
        {state.paused ? <span className="tag warn">Paused</span> : <><p className="eyebrow mt">Next round in</p><p className="big">{left(state.closesAt)}s</p></>}
      </section>
    );
  }

  return (
    <section className="card hi">
      <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <span className="tag">{state.label}</span>
            {state.weight != null && state.weight !== 1 && !state.practice && <span className="tag y">{state.weight}× points</span>}
          </div>
          <Dots n={state.qn} total={state.qTotal} />
        </div>
        <div style={{ flex: "none", whiteSpace: "nowrap" }}>
          {state.paused ? <span className="tag warn">Paused</span> : state.phase === "open" ? <span className={`clock ${left(state.closesAt) <= 10 ? "hot" : ""}`}>{left(state.closesAt)}s</span> : state.phase === "reveal" && state.revealEndsAt ? <span className="tag line">Next in {left(state.revealEndsAt)}s</span> : <span className="tag line">Time&apos;s up</span>}
        </div>
      </div>
      <h2 className="question">{state.text}</h2>
      {state.unit && <p className="muted m0">Answer in <span className="hl">{state.unit}</span></p>}
      <div className="rule dash" />
      {(state.phase === "open" || state.phase === "closing") && state.index !== null && playerId !== null && (
        <AnswerBox key={state.index} item={state.index} playerId={playerId} initial={myItem?.value ?? null} initialSeq={myItem?.seq ?? 0} phase={state.phase} closesAt={state.closesAt} onAuthLost={onAuthLost} />
      )}
      {state.phase === "reveal" && state.range && (
        <div>
          {answerOf(state.range) !== null ? (
            <><p className="eyebrow">Answer</p><p className="big" style={{ fontSize: 44 }}>{fmt(answerOf(state.range))} <small className="muted" style={{ fontSize: 18 }}>{state.unit}</small></p></>
          ) : null}
          {state.range.low !== state.range.high && (
            <><p className="eyebrow">{answerOf(state.range) !== null ? "Full points for" : "Accepted range"}</p><p className="big" style={{ fontSize: answerOf(state.range) !== null ? 24 : 40 }}>{fmt(state.range.low)} – {fmt(state.range.high)}</p></>
          )}
          <div className="fields">
            <div className="field"><span>Your answer</span><b>{myItem?.revealed ? fmt(myItem.value) : "…"}</b></div>
            <div className="field"><span>{me && lowerWins(me.scoring) ? "Penalty (0 is best)" : `Points${state.weight && state.weight !== 1 ? ` (${state.weight}×)` : ""}`}</span><b>{myItem?.revealed ? myItem.penalty : "…"}</b></div>
            {!state.practice && me && <div className="field"><span>Your total</span><b>{me.total}</b></div>}
          </div>
          {state.range.note && !/^draft/i.test(state.range.note) && <p className="muted small">{state.range.note}</p>}
        </div>
      )}
    </section>
  );
}

function AnswerBox({ item, playerId, initial, initialSeq, phase, closesAt, onAuthLost }: { item: number; playerId: number; initial: number | null; initialSeq: number; phase: string; closesAt: number | null; onAuthLost: () => void }) {
  const queued = readQueue(playerId)[item];
  const [text, setText] = useState(queued?.value ?? (initial != null ? String(initial) : ""));
  const [status, setStatus] = useState<SaveStatus>(initial != null && !queued ? { kind: "saved", value: initial } : { kind: "idle" });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(Math.max(initialSeq, queued?.seq ?? 0));
  const ack = useRef(0); // highest seq the server has confirmed: an older, late reply never overwrites "Saved"
  const textRef = useRef(text);
  textRef.current = text;

  const send = useCallback(async () => {
    const pending = readQueue(playerId)[item];
    if (!pending) return;
    setStatus({ kind: "saving" });
    const r = await postJson<{ ok: true; seq: number; value: number; serverNow: number }>("/api/answer", pending);
    if (r.ok) {
      noteClock(r.data.serverNow, r.t0, r.t1);
      if (r.data.seq < ack.current) return;
      ack.current = r.data.seq;
      lastSeq.current = Math.max(lastSeq.current, r.data.seq);
      const qd = readQueue(playerId);
      if (qd[item] && qd[item].seq <= r.data.seq) { delete qd[item]; writeQueue(playerId, qd); }
      if (r.data.seq >= pending.seq) setStatus({ kind: "saved", value: r.data.value });
      return;
    }
    if (r.status === 401) return onAuthLost();
    if (r.status === 409) {
      const qd = readQueue(playerId); delete qd[item]; writeQueue(playerId, qd);
      return setStatus({ kind: "closed" });
    }
    if ("network" in r && !r.network && r.data?.retry === false) return setStatus({ kind: "error", why: r.data?.error ?? "Not accepted" });
    setStatus({ kind: "unsaved", why: "No connection" });
    if (retry.current) clearTimeout(retry.current);
    retry.current = setTimeout(() => void send(), 2000);
  }, [item, playerId, onAuthLost]);

  const enqueue = useCallback((raw: string) => {
    if (parseAnswer(raw) === null) return false;
    const seq = Math.max(nextSeq(), lastSeq.current + 1);
    lastSeq.current = seq;
    const qd = readQueue(playerId);
    qd[item] = { item, value: raw, seq };
    writeQueue(playerId, qd);
    return true;
  }, [item, playerId]);

  // Retry anything left from before a reload.
  useEffect(() => { if (queued) void send(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Flush immediately when the page is hidden (app switch) or closed.
  useEffect(() => {
    const flush = (e: Event) => {
      // back on screen: anything still queued (the beacon may not have landed) is sent and confirmed
      if (e.type === "visibilitychange" && document.visibilityState === "visible") { if (readQueue(playerId)[item]) void send(); return; }
      // an answer still waiting for the typing pause is queued now, so locking the phone doesn't lose it
      if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; enqueue(textRef.current); }
      const p = readQueue(playerId)[item];
      if (p) beaconSave(p);
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
      if (debounce.current) clearTimeout(debounce.current);
      if (retry.current) clearTimeout(retry.current);
    };
  }, [item, playerId]);

  function onChange(v: string) {
    const clean = v.replace(/[^\d.,\s]/g, "");
    setText(clean);
    if (debounce.current) clearTimeout(debounce.current);
    if (clean.trim() === "") return setStatus({ kind: "idle" });
    if (parseAnswer(clean) === null) return setStatus({ kind: "error", why: "Numbers only (one decimal point, up to 15 digits)" });
    setStatus({ kind: "unsaved", why: "Typing…" });
    // Every keystroke is stored on the phone at once (so closing the tab can't lose it: it is beaconed on
    // close and retried on reopen); only the network send waits for a pause in typing.
    enqueue(clean);
    // near the deadline, send almost at once so the 2 s grace isn't spent waiting for the typing pause
    const delay = closesAt != null && serverNow() > closesAt - 5000 ? 250 : 1200;
    debounce.current = setTimeout(() => { debounce.current = null; void send(); }, delay);
  }

  function commit() {
    if (debounce.current) clearTimeout(debounce.current);
    const v = textRef.current;
    if (parseAnswer(v) === null) return;
    if (status.kind === "saved" && status.value === parseAnswer(v)) return;
    if (enqueue(v)) void send();
  }

  const n = parseAnswer(text);
  return (
    <>
    <form onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <input
        className="num"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label="Your estimate"
        placeholder="e.g. 1500"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commit}
        disabled={phase === "closing" && status.kind === "closed"}
      />
      <div className="words">{n !== null ? <>= {formatIndian(n)}{n >= 1000 ? ` (${inWords(n)})` : ""}</> : " "}</div>
      <button className="primary">Save answer</button>
      <Status s={status} />
      </form>
      {!(phase === "closing" && status.kind === "closed") && <Calc onUse={onChange} />}
    </>
  );
}

function Status({ s }: { s: SaveStatus }) {
  switch (s.kind) {
    case "saved": return <p className="status ok">✓ Saved · {formatIndian(s.value)}</p>;
    case "saving": return <p className="status muted">Saving…</p>;
    case "unsaved": return <p className="status err">Not saved yet: {s.why}. Keep this page open; it retries.</p>;
    case "closed": return <p className="status muted">Time&apos;s up for this round.</p>;
    case "error": return <p className="status err">{s.why}</p>;
    default: return <p className="status muted">Saves as you type. Your last saved answer counts.</p>;
  }
}

function Lobby({ me, note, now }: { me: Me | null; note: string; now: number }) {
  const bands = me?.scoring;
  const lower = bands ? lowerWins(bands) : true;
  const plan = me?.plan ?? [];
  const total = plan.reduce((t, p) => t + p.count, 0);
  return (
    <>
      <section className="card y">
        <p className="eyebrow" style={{ color: "#000" }}>You&apos;re in, {me ? me.name : "…"}</p>
        <h1 style={{ margin: "4px 0 6px", textTransform: "none", fontSize: 28, lineHeight: 1.1 }}>{note || "Starting soon"}</h1>
        <p className="m0">Time now <b className="mono" style={{ fontSize: 22 }}>{ist(now)}</b></p>
      </section>
      <section className="card">
        <p className="m0"><b>You&apos;re all set.</b> Keep this page open, or close it and open the same link when you arrive: you&apos;ll still be logged in. The game starts on every phone at the same moment, with a 10-second countdown.</p>
      </section>
      <section className="card hi">
        <h3 style={{ marginTop: 0 }}>How it works</h3>
        <ul>
          <li>{total ? `${total} questions` : "A series of questions"}, each with its own timer. Type a number; it saves by itself. Your last saved answer counts.</li>
          <li>After each question the answer is shown with your points. The leaderboard stays secret until the last question.</li>
        </ul>
        {plan.length > 0 && (
          <table className="small"><thead><tr><th>Round</th><th className="n">Questions</th><th className="n">Time each</th><th className="n">Points</th></tr></thead><tbody>
            {plan.map((p, i) => <tr key={i}><td>{p.section || `Part ${i + 1}`}</td><td className="n">{p.count}</td><td className="n">{mmss(p.seconds)}</td><td className="n">{p.weight}×</td></tr>)}
          </tbody></table>
        )}
        {bands && (
          <>
            <p className="mt m0"><b>Points per question</b> (then multiplied as above):</p>
            <table className="small"><tbody>
              {describeBands(bands).map(([label, pts]) => <tr key={label}><td>{label}</td><td className="n">{pts}</td></tr>)}
            </tbody></table>
          </>
        )}
        <ul className="mt">
          <li>{lower ? "Lowest" : "Highest"} total wins. Ties: fewer blanks, then how close your answers were overall, then speed.</li>
          <li>The top scorers go through to Round 2; the organisers announce how many at the end{me?.qualifyCount ? ` (top ${me.qualifyCount})` : ""}.</li>
          <li>Logged out by mistake? Log in again with the same BITS ID and PIN.</li>
        </ul>
      </section>
    </>
  );
}

function Countdown({ state, me, secs }: { state: PublicState; me: Me | null; secs: number }) {
  const first = me?.plan?.[0];
  return (
    <section className="card y center">
      <p className="eyebrow" style={{ color: "#000" }}>Get ready</p>
      <h1 style={{ margin: 0 }}>Starting in</h1>
      {state.paused ? <p className="big" style={{ color: "#000" }}>Paused</p> : <p className="big" style={{ fontSize: 120, lineHeight: 1, margin: "10px 0", color: "#000" }}>{secs}</p>}
      <p className="m0">{state.section ? <b>{state.section} round</b> : <b>First question</b>}{first && first.section === (state.section ?? "") ? ` · ${first.count} questions · ${mmss(first.seconds)} each` : ""}</p>
    </section>
  );
}

function Results({ me }: { me: Me | null }) {
  const board = useBoard();
  if (!me) return <section className="card"><p className="muted">Loading results…</p></section>;
  const loading = !!me.pending;
  const decided = me.qualifyCount > 0 && !loading;
  const q = decided && me.eligibleRank !== null && me.eligibleRank <= me.qualifyCount && !me.disqualified;
  return (
    <>
      <section className={`card ${q ? "y" : "hi"}`}>
        <p className="eyebrow" style={q ? { color: "#000" } : undefined}>Final results</p>
        <h1>{!decided ? "Results are in" : q ? "You're through to Round 2" : "Thanks for playing"}</h1>
        {loading && <p className="m0">Working out the final ranking…</p>}
        {!decided && !loading && <p className="m0">The organisers will announce how many qualify. This page updates by itself.</p>}
        {q && <p className="m0"><b>Stay on this page.</b> Round 2 opens here.</p>}
        {decided && !q && <p className="m0">The top {me.qualifyCount} go through{me.eligibleRank ? `; you finished #${me.eligibleRank}` : ""}. Thanks for playing!</p>}
        <div className="fields">
          <div className="field"><span>Total</span><b className="big" style={q ? { color: "#000" } : undefined}>{me.total}</b></div>
          <div className="field"><span>Rank</span><b className="big" style={q ? { color: "#000" } : undefined}>{me.rank ?? "—"}</b><span>of {me.players ?? "—"}</span></div>
        </div>
        <table className="small"><thead><tr><th>Question</th><th className="n">You</th><th className="n">Answer</th><th className="n">{lowerWins(me.scoring) ? "Penalty" : "Points"}</th></tr></thead><tbody>
          {me.items.filter((i) => !i.practice).map((i) => (
            <tr key={i.idx}><td>{i.label.replace(/ of \d+$/, "")}</td><td className="n">{fmt(i.value)}</td><td className="n">{fmt(answerOf(i.range))}</td><td className="n">{i.penalty ?? "—"}</td></tr>
          ))}
        </tbody></table>
      </section>
      <Leaderboard board={board} myId={me.playerId} />
    </>
  );
}

function useBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const r = await api<Board>("/api/leaderboard");
      if (!alive) return;
      if (r.ok) setBoard(r.data);
      if (!r.ok || !r.data.ready) retry = setTimeout(load, 2000 + Math.random() * 2000); // ranking still being computed
    };
    void load();
    const id = setInterval(load, 15000 + Math.random() * 5000);
    return () => { alive = false; clearInterval(id); if (retry) clearTimeout(retry); };
  }, []);
  return board;
}

function Leaderboard({ board, myId }: { board: Board | null; myId: number }) {
  if (!board?.ready || !board.top.length) return null;
  return (
    <section className="card">
      <h3>Leaderboard</h3>
      {board.qualifyCount > 0 && <p className="small muted">The yellow line is the cut-off: the top {board.qualifyCount} go through.</p>}
      <table><tbody>
        {board.top.map((r) => (
          <tr key={r.rank} className={`${r.pid === myId ? "me" : ""} ${board.qualifyCount && r.eligible_rank !== null && r.eligible_rank <= board.qualifyCount ? "in" : ""} ${board.qualifyCount && r.eligible_rank === board.qualifyCount ? "cut" : ""}`}>
            <td className="n" style={{ width: 40 }}>{r.rank}</td><td>{r.name}</td><td className="n">{r.total}</td>
          </tr>
        ))}
      </tbody></table>
    </section>
  );
}

function Dots({ n, total }: { n: number | null; total: number }) {
  if (n === null || !total || total > 30) return null;
  return <div className="dots" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i key={i} className={i + 1 < n ? "done" : i + 1 === n ? "now" : ""} />)}</div>;
}
