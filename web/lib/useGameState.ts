"use client";
import { useEffect, useRef, useState } from "react";
import { api, expectedNextKey, serverNow, type PublicState } from "./client";

const FALLBACK_MS = 10_000;
// In the lobby, check more often so every phone catches the 10-second "Starting in" countdown.
const LOBBY_MS = 4_000;

/**
 * Keeps the public game state fresh with as few requests as possible:
 * sleep until the next scheduled change (+ jitter), poll every 10 s otherwise,
 * and refetch immediately when the tab comes back or the network returns.
 */
export function useGameState(jitterMs = 1000) {
  const [state, setState] = useState<PublicState | null>(null);
  const [offline, setOffline] = useState(false);
  const ref = useRef<PublicState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;

    const schedule = (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void tick(), Math.max(50, ms));
    };

    async function tick(wantKey?: string | null) {
      if (!alive) return;
      if (busy.current) return schedule(300);
      busy.current = true;
      const cur = ref.current;
      const k = wantKey ?? cur?.key ?? "init";
      const r = await api<PublicState>(`/api/state?k=${encodeURIComponent(k)}`, {}, 4000);
      busy.current = false;
      if (!alive) return;
      if (!r.ok) {
        setOffline(true);
        return schedule(3000);
      }
      setOffline(false);
      const s = r.data;
      ref.current = s;
      setState(s);
      // Arrived too early for the change we expected (stale cache): retry soon.
      if (wantKey && s.key !== wantKey && s.nextChangeAt !== null && s.serverNow < s.nextChangeAt) return schedule(400);
      if (s.nextChangeAt !== null && !s.paused) {
        const wait = s.nextChangeAt - serverNow() + Math.random() * jitterMs;
        if (wait < FALLBACK_MS) {
          if (timer.current) clearTimeout(timer.current);
          const next = expectedNextKey(s, s.count);
          timer.current = setTimeout(() => void tick(next), Math.max(50, wait));
          return;
        }
      }
      // paused: check every 2–3 s so Resume shows on every phone at once
      schedule(s.paused ? 2000 + Math.random() * 1000 : s.phase === "lobby" ? LOBBY_MS + Math.random() * 1000 : FALLBACK_MS);
    }

    const wake = () => {
      if (document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [jitterMs]);

  return { state, offline };
}

/** Re-render every animation frame-ish (250 ms) for countdowns computed from the server clock. */
export function useNow(intervalMs = 250) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return serverNow();
}
