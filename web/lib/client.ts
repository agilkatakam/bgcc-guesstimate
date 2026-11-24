"use client";
// Browser-side networking: timeouts, retries, the second hostname, the clock
// offset and the offline answer queue. Nothing here is trusted by the server.

export type PublicState = {
  key: string;
  phase: "lobby" | "countdown" | "open" | "closing" | "reveal" | "results";
  paused: boolean;
  index: number | null;
  count: number;
  label: string | null;
  section: string | null; // "Easy", "Medium", "Hard" (or empty)
  weight: number | null; // points multiplier of the current question
  qn: number | null; // scored question number (1-based); null for practice/breaks
  qTotal: number; // scored questions in the game
  lobbyNote: string; // lobby only: e.g. "Starts around 5:10 to 5:15 PM"
  kind: "q" | "break" | null;
  practice: boolean;
  text: string | null;
  unit: string | null;
  opensAt: number | null;
  closesAt: number | null;
  revealAt: number | null;
  revealEndsAt: number | null;
  nextChangeAt: number | null;
  range: { low: number; high: number; answer: number | null; note: string } | null;
  serverNow: number;
  mystery?: "closed" | "teams" | "play" | "ended";
};

export type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; data: (T & { error?: string; retry?: boolean }) | null; network: boolean };

// ---- storage (private mode / blocked storage must never break the page) ----

// An in-memory copy backs every value, so a browser that blocks storage still keeps the login and the
// answer queue for as long as the page is open.
const mem = new Map<string, string>();
export const store = {
  get(k: string): string | null {
    try { const v = localStorage.getItem(k); if (v !== null) return v; } catch { /* blocked */ }
    return mem.get(k) ?? null;
  },
  set(k: string, v: string) {
    mem.set(k, v);
    try { localStorage.setItem(k, v); } catch { /* ignore */ }
  },
  del(k: string) {
    mem.delete(k);
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

export const getToken = () => store.get("vq_token");
export const setToken = (t: string | null) => (t ? store.set("vq_token", t) : store.del("vq_token"));

// ---- clock: offset from uncached responses, lowest round trip wins ----

let offset = 0;
let bestRtt = Infinity;
let bestAt = 0;
export function noteClock(serverNow: number, t0: number, t1: number) {
  const rtt = t1 - t0;
  // re-sample now and then so a long session can't keep a bad early sample
  // a new sample only replaces the best one if it was quick (a stalled reply would skew every timer)
  if (rtt <= bestRtt || (Date.now() - bestAt > 120_000 && rtt <= 1500)) {
    bestRtt = rtt;
    bestAt = Date.now();
    offset = serverNow - (t0 + t1) / 2;
  }
}
export const serverNow = () => Date.now() + offset;

// ---- fetch with timeout, one retry, then the alternate hostname ----

const ALT = process.env.NEXT_PUBLIC_ALT_ORIGIN || "";
let preferAlt = false;

async function once<T>(base: string, path: string, init: RequestInit, timeoutMs: number): Promise<Result<T> & { t0: number; t1: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const token = getToken();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { ...init, headers, signal: ctl.signal, cache: "no-store", credentials: base ? "omit" : "same-origin" });
    const t1 = Date.now();
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    if (!isJson) return { ok: false, status: res.status, data: null, network: true, t0, t1 }; // captive portal, firewall page
    const data = (await res.json()) as T;
    // Our API always answers errors with {ok:false,…}. A JSON error without that shape, or a 5xx, came from the
    // platform (firewall / rate limit / outage), so treat it like a network failure and try the other host.
    if (!res.ok && (res.status >= 500 || !(data && typeof data === "object" && "ok" in data)))
      return { ok: false, status: res.status, data: null, network: true, t0, t1 };
    if (!res.ok) return { ok: false, status: res.status, data: data as never, network: false, t0, t1 };
    return { ok: true, status: res.status, data, t0, t1 };
  } catch {
    return { ok: false, status: 0, data: null, network: true, t0, t1: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

export async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 3500): Promise<Result<T> & { t0: number; t1: number }> {
  const bases = preferAlt && ALT ? [ALT, "", ALT] : ["", "", ...(ALT ? [ALT] : [])];
  let last!: Result<T> & { t0: number; t1: number };
  for (const base of bases) {
    last = await once<T>(base, path, init, timeoutMs);
    if (last.ok || !("network" in last) || !last.network) {
      if (last.ok && base === ALT && ALT) preferAlt = true;
      return last;
    }
  }
  return last;
}

export const postJson = <T>(path: string, body: unknown, extra: RequestInit = {}) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...extra });

// ---- answer queue: survives reloads; newest seq wins on the server ----

type Pending = { item: number; value: string; seq: number };
const qKey = (pid: number) => `vq_pending_${pid}`;

let seqCounter = 0;
export const nextSeq = () => Math.floor(serverNow()) * 1000 + (seqCounter = (seqCounter + 1) % 1000);

export function readQueue(pid: number): Record<number, Pending> {
  try { return JSON.parse(store.get(qKey(pid)) ?? "{}"); } catch { return {}; }
}
export function writeQueue(pid: number, qd: Record<number, Pending>) {
  store.set(qKey(pid), JSON.stringify(qd));
}

/** Best-effort save while the page is being hidden or closed. */
export function beaconSave(p: Pending) {
  try {
    const token = getToken();
    fetch("/api/answer", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(p),
    }).catch(() => {});
  } catch { /* ignore */ }
}

export const isInAppBrowser = () =>
  typeof navigator !== "undefined" && /Instagram|FBAN|FBAV|Line\/|WhatsApp|LinkedInApp|Snapchat|Twitter|; wv\)/i.test(navigator.userAgent);

/** Key the state endpoint should report after the current phase ends. */
export function expectedNextKey(s: PublicState, scheduleLength: number | null): string | null {
  const [version] = s.key.split("-");
  if (s.index === null) return null;
  if (s.phase === "countdown") return `${version}-${s.index}-open`;
  if (s.phase === "open") return `${version}-${s.index}-closing`;
  if (s.phase === "closing") return `${version}-${s.index}-reveal`;
  if (s.phase === "reveal") {
    if (scheduleLength !== null && s.index + 1 >= scheduleLength) return `${version}-x-results`;
    return `${version}-${s.index + 1}-open`;
  }
  return null;
}
