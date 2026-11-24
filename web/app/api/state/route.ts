import { load, stateOf, keyOf, labelFor, numbering } from "@/lib/game";
import { corsHeaders, preflight } from "@/lib/http";
import { stateChangedAt } from "@/lib/db";
import { loadMystery } from "@/lib/mystery";

export const dynamic = "force-dynamic";

// Public, CDN-cacheable game state. Never reads cookies. Question text only
// while open/closing; range only during reveal; nothing about future items.
// Hundreds of phones sit on the lobby for hours and all wake at each phase change. One process
// serves them all, so the body is rebuilt at most every 250 ms (and at once when the phase moves on).
let cached: { at: number; until: number; body: Record<string, unknown>; key: string } | null = null;
let inflight: Promise<Awaited<ReturnType<typeof build>>> | null = null; // one rebuild at a time
let inflightAt = 0;

async function build() {
  const L = await load();
  // The mystery stage rides along on this cached response so ~500 phones don't poll /api/mystery/me during the qualifier.
  // A missing mystery table must never break the qualifier.
  const mystery = await loadMystery().then((m) => m?.stage ?? "closed", () => "closed" as const);
  const s = stateOf(L);
  const key = keyOf(L, s);
  const x = s.index !== null ? L.questions[s.index] : null;
  const showQ = x && (s.phase === "open" || s.phase === "closing" || s.phase === "reveal");
  const num = s.index !== null ? numbering(L.questions, s.index) : { n: null, total: numbering(L.questions, -1).total };
  const body = {
    key,
    phase: s.phase,
    paused: s.paused,
    index: s.index,
    count: L.items.length,
    label: x ? labelFor(L.questions, s.index!) : null,
    section: x?.section || null,
    weight: x?.kind === "q" ? x.weight : null,
    qn: num.n,
    qTotal: num.total,
    lobbyNote: s.phase === "lobby" ? L.lobbyNote : "",
    kind: x?.kind ?? null,
    practice: x?.practice ?? false,
    text: showQ ? x.text : null,
    unit: showQ ? x.unit : null,
    opensAt: s.opensAt,
    closesAt: s.closesAt,
    revealAt: s.revealAt,
    revealEndsAt: s.revealEndsAt,
    nextChangeAt: s.nextChangeAt,
    range: s.phase === "reveal" && x?.kind === "q" ? { low: x.low, high: x.high, answer: x.answer, note: x.note } : null,
    serverNow: L.now,
    mystery,
  };
  return { body, key, nextChangeAt: s.nextChangeAt, now: L.now };
}

export async function GET(req: Request) {
  const t = Date.now();
  if (!cached || t >= cached.until || stateChangedAt() >= cached.at) {
    // join a rebuild only if it started after the last change; otherwise start a fresh one
    if (!inflight || stateChangedAt() >= inflightAt) { inflightAt = Date.now(); inflight = build().finally(() => { inflight = null; }); }
    const b = await inflight;
    // never serve a cached body past the moment its phase ends
    const until = Math.min(t + 250, b.nextChangeAt !== null ? t + Math.max(0, b.nextChangeAt - b.now) : Infinity);
    cached = { at: t, until, body: b.body, key: b.key };
  }
  const key = cached.key;
  const body = { ...cached.body, serverNow: (cached.body.serverNow as number) + (t - cached.at) };
  const wanted = new URL(req.url).searchParams.get("k");
  // Cache only when the caller asked for exactly the live key, so a request
  // that arrives early can never cache old content under a new key.
  const cache = wanted === key ? "public, s-maxage=1, stale-while-revalidate=1" : "no-store";
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": cache, ...corsHeaders(req) },
  });
}

export const OPTIONS = preflight;
