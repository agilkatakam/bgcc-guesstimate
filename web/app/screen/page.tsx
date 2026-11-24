"use client";
import { useEffect, useState } from "react";
import { api, noteClock } from "@/lib/client";
import { useGameState, useNow } from "@/lib/useGameState";
import { formatIndian } from "@/lib/parse";
import { Qr } from "@/lib/Qr";

// Projector view. Public data only: question, range at reveal, leaderboard names, Round 2 stage and (once published) standings.

type Board = { ready: boolean; through: string | null; players: number; qualifyCount: number; top: { rank: number; name: string; total: number; eligible: boolean; eligible_rank: number | null }[] };
type MysteryPublic = { stage: string; submissionsOpen: boolean; answersOnline?: boolean; teams: number; results: { rank: number; name: string; opened: number; at: string; correct: boolean }[] | null };

const ist = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });

function Head({ right }: { right?: React.ReactNode }) {
  return (
    <div className="shead">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="BGCC: BITS Goa Consulting Club" />
      <span>BGCC · Pre-induction</span>
      <span style={{ marginLeft: "auto" }}>{right}</span>
    </div>
  );
}

function MysteryScreen({ m }: { m: MysteryPublic }) {
  const line =
    m.stage === "teams" ? "Form your teams on your phones. One lead per team." :
    m.stage === "ended" ? "Case closed." :
    m.answersOnline === false ? "Investigation under way. Every exhibit you open counts. Ready? Tell an organiser your answer in person." :
    m.submissionsOpen ? "Submissions are open. Fewest exhibits opened with a correct answer wins." :
    "Investigation under way. Every exhibit you open counts.";
  const r = null as MysteryPublic["results"]; // standings are never shown on the projector (announced live)
  return (
    <main className="screen">
      <Head right={`${m.teams} team${m.teams === 1 ? "" : "s"}`} />
      <p className="skick">Round 2</p>
      <h1 className="stitle" style={r?.length ? { fontSize: "4.5vw" } : undefined}>The Vardhan Case</h1>
      {!r?.length && <p className="sline">{line}</p>}
      {m.stage === "teams" && (
        <ol className="ssteps">
          <li><b>Lead:</b> tap <span className="hl">Create (lead)</span>, name your team, read out the 5-letter code.</li>
          <li><b>Everyone else:</b> tap <span className="hl">Join a team</span> and type that code.</li>
          <li>Ask us for an exhibit; type its code on any teammate&apos;s phone. Fewest exhibits opened with a correct answer wins.</li>
        </ol>
      )}
      {r && r.length > 0 && (
        <div className="swin">
          <p className="skick" style={{ color: "#000" }}>Winner</p>
          <p className="steam">{r[0].name}</p>
          <p className="sline" style={{ color: "#000" }}>{r[0].correct ? `Correct with ${r[0].opened} exhibit${r[0].opened === 1 ? "" : "s"} opened · submitted ${clock(r[0].at)}` : "Nobody was fully correct: most of the story right"}</p>
        </div>
      )}
      {r && r.length > 1 && (
        <table className="sboard"><tbody>
          {r.slice(1, 9).map((x) => <tr key={x.rank}><td>{x.rank}</td><td>{x.name}</td><td>{x.correct ? `correct · ${x.opened} opened` : `${x.opened} opened`}</td></tr>)}
        </tbody></table>
      )}
      <ScreenStyle />
    </main>
  );
}

export default function Screen() {
  const { state, offline } = useGameState(0);
  const now = useNow(200);
  const [board, setBoard] = useState<Board | null>(null);
  const [mys, setMys] = useState<MysteryPublic | null>(null);
  const [site, setSite] = useState("");
  useEffect(() => setSite(`${window.location.host}/play`), []);
  const fullUrl = site ? `${window.location.protocol}//${site}` : "";

  useEffect(() => {
    const sync = async () => {
      const r = await api<{ serverNow: number }>("/api/time");
      if (r.ok) noteClock(r.data.serverNow, r.t0, r.t1);
    };
    void sync();
    const id = setInterval(sync, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => { const r = await api<Board>("/api/leaderboard"); if (alive && r.ok) setBoard(r.data); };
    void load();
    const id = setInterval(load, 8000);
    return () => { alive = false; clearInterval(id); };
  }, [state?.key]);

  useEffect(() => {
    let alive = true;
    const load = async () => { const r = await api<MysteryPublic>("/api/mystery/public"); if (alive && r.ok) setMys(r.data); };
    void load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (mys && mys.stage !== "closed") return <MysteryScreen m={mys} />;

  const left = (t: number | null) => (t == null ? 0 : Math.max(0, Math.ceil((t - now) / 1000)));
  // Ranks stay hidden until the end (the server hides them too); then the top 10.
  const showBoard = state && state.phase === "results";


  return (
    <main className="screen">
      {offline && <div className="banner bad">Screen offline: retrying…</div>}
      <Head right={`${board?.players ?? "…"} player${board?.players === 1 ? "" : "s"}`} />
      {!state ? <p className="sline">Connecting…</p> : (
        <>
          <div className="srow">
            <span className="stag">{state.phase === "lobby" ? "Waiting to start" : state.phase === "results" ? "Final results" : state.phase === "countdown" ? "Get ready" : state.label}</span>
            {state.weight != null && state.weight !== 1 && !state.practice && state.phase !== "countdown" && <span className="stag y">{state.weight}× points</span>}
            {state.paused && <span className="stag y">Paused</span>}
            {state.phase === "reveal" && !state.paused && state.revealEndsAt && <span className="stag" style={{ marginLeft: "auto" }}>Next in {left(state.revealEndsAt)}s</span>}
            {state.phase === "open" && !state.paused && <span className={`sclock ${left(state.closesAt) <= 10 ? "hot" : ""}`}>{left(state.closesAt)}</span>}
          </div>
          {(state.phase === "open" || state.phase === "closing" || state.phase === "reveal") && (
            <div className="sq">
              <h1>{state.text}</h1>
              {state.unit && <p className="sline">Answer in {state.unit}</p>}
              {state.phase === "reveal" && state.range && (() => {
                const a = state.range.answer ?? (state.range.low === state.range.high ? state.range.low : null);
                return (
                  <>
                    <p className="skick" style={{ marginTop: "4vh" }}>{a !== null ? "Answer" : "Accepted range"}</p>
                    <p className="srange">{a !== null ? formatIndian(a) : `${formatIndian(state.range.low)} – ${formatIndian(state.range.high)}`} {state.unit}</p>
                    {state.range.note && !/^draft/i.test(state.range.note) && <p className="sline" style={{ marginTop: "2vh", fontSize: "min(2vw, 3.4vh)" }}>{state.range.note}</p>}
                  </>
                );
              })()}
            </div>
          )}
          {state.phase === "lobby" && (
            <>
              <div className="srow" style={{ marginTop: "3vh", alignItems: "baseline" }}>
                <p className="snote">{state.lobbyNote || "Starting soon"}</p>
                <p className="snow">{ist(now)}</p>
              </div>
              <div className="sq lobby" style={{ display: "flex", gap: "3vw", alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p className="skick">Scan, or on your phone open</p>
                  <p className="surl">{site.replace(/\./g, ".\u200b").replace("/", "\u200b/")}</p>
                  <h1>Log in with your BITS ID (like f20260123), your name and a 4-digit PIN you choose. Remember the PIN.</h1>
                </div>
                {fullUrl && <Qr text={fullUrl} size={300} className="sqr" />}
              </div>
            </>
          )}
          {state.phase === "countdown" && (
            <div className="sq" style={{ textAlign: "center" }}>
              <p className="skick">{state.section ? `${state.section} round` : "First question"} starts in</p>
              <p className="scount">{state.paused ? "Paused" : left(state.opensAt)}</p>
            </div>
          )}
          {showBoard && board?.ready && board.top.length > 0 && (
            <>
            {board.qualifyCount > 0 && <p className="skick" style={{ marginTop: "4vh" }}>Top {board.qualifyCount} go to Round 2</p>}
            <table className="sboard"><tbody>
              {board.top.slice(0, 10).map((r) => (
                <tr key={r.rank} className={`${board.qualifyCount && r.eligible_rank !== null && r.eligible_rank <= board.qualifyCount ? "in" : ""} ${board.qualifyCount && r.eligible_rank === board.qualifyCount ? "cut" : ""}`}>
                  <td>{r.rank}</td><td>{r.name}</td><td>{r.total}</td>
                </tr>
              ))}
            </tbody></table>
            </>
          )}
        </>
      )}
      <ScreenStyle />
    </main>
  );
}

function ScreenStyle() {
  return (
    <style>{`
      .screen { min-height: 100vh; padding: 3vh 5vw 6vh; }
      .shead { display: flex; align-items: center; gap: 1.2vw; font: 700 1.5vw var(--mono); text-transform: uppercase; letter-spacing: .12em; border-bottom: .35vw solid #fff; padding-bottom: 2vh; margin-bottom: 4vh; }
      .shead img { height: 4.5vw; width: auto; }
      .skick { font: 700 1.6vw var(--mono); letter-spacing: .25em; text-transform: uppercase; color: var(--y); margin: 0; }
      .stitle { font-size: 8.5vw; line-height: .95; margin: 2vh 0 3vh; text-transform: uppercase; letter-spacing: -.03em; }
      .sline { font-size: 2.4vw; margin: 0; }
      .swin { margin-top: 5vh; background: var(--y); color: #000; padding: 3vh 3vw; box-shadow: 1vw 1vw 0 #fff; max-width: 85vw; }
      .steam { font-size: 6vw; font-weight: 700; margin: 1vh 0; text-transform: uppercase; line-height: 1; }
      .srow { display: flex; gap: 1.2vw; align-items: center; }
      .stag { font: 700 1.8vw var(--mono); text-transform: uppercase; background: #fff; color: #000; padding: .4em .8em; }
      .stag.y { background: var(--y); }
      .sclock { margin-left: auto; font: 700 6vw/1 var(--mono); background: var(--y); color: #000; padding: .1em .3em; font-variant-numeric: tabular-nums; }
      .sclock.hot { background: var(--err); color: #fff; }
      .sq { border: .4vw solid #fff; padding: 4vh 3.5vw; margin-top: 4vh; box-shadow: 1vw 1vw 0 var(--y); }
      .sq h1 { font-size: min(4.2vw, 6.5vh); line-height: 1.15; margin: 0; text-transform: none; }
      .surl { font: 700 min(6vw, 10vh) var(--mono); color: var(--y); margin: 1vh 0 3vh; word-break: break-all; }
      .ssteps { font-size: min(2.4vw, 4vh); margin-top: 4vh; padding-left: 1.2em; }
      .ssteps li { margin: 1.5vh 0; }
      .hl { background: var(--y); color: #000; padding: 0 .3em; }
      .sqr { width: min(22vw, 36vh); height: auto; flex: none; }
      .lobby .surl { font-size: min(3.4vw, 6vh); word-break: normal; overflow-wrap: normal; }
      .lobby .sq h1 { font-size: min(3vw, 5vh); }
      .snote { font-size: min(3.4vw, 6vh); font-weight: 700; margin: 0; line-height: 1.05; }
      .snow { margin: 0 0 0 auto; font: 700 min(4vw, 7vh) var(--mono); color: var(--y); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .scount { font: 700 min(22vw, 40vh)/1 var(--mono); color: var(--y); margin: 2vh 0; font-variant-numeric: tabular-nums; }
      .srange { font: 700 min(5.5vw, 8vh) var(--mono); color: var(--y); margin: 1vh 0 0; }
      table.sboard { font-size: min(2.4vw, 3.6vh); width: auto; min-width: 60vw; margin-top: 4vh; border: .35vw solid #fff; }
      .sboard td { border-bottom: .2vw solid #333; padding: .8vh 1.5vw; }
      .sboard td:first-child { font-family: var(--mono); color: var(--muted); }
      .sboard td:last-child { text-align: right; font-family: var(--mono); font-weight: 700; }
      .sboard tr.in td:first-child { color: var(--y); }
      .sboard tr.cut td { border-bottom: .5vw solid var(--y); }
    `}</style>
  );
}
