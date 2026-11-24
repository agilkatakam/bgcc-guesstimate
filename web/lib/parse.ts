// Answers are plain numbers. Commas and spaces are ignored, one decimal point allowed.

const NUM = /^(\d+(\.\d*)?|\.\d+)$/;

export function parseAnswer(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "");
  if (!NUM.test(s)) return null;
  if (s.replace(".", "").replace(/^0+/, "").length > 15) return null; // max 15 significant digits
  const n = Number(s);
  return Number.isFinite(n) && n <= 1e15 ? n : null;
}

/** 2500000.5 -> "25,00,000.5" (Indian grouping). */
export function formatIndian(n: number): string {
  const [int, frac] = String(n).split(".");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (rest ? rest + "," : "") + last3 + (frac ? "." + frac : "");
}

const EMAIL_DEFAULT = /^f\d{8}@goa\.bits-pilani\.ac\.in$/;

/** Accepts the full email or just the ID ("f20260123"), any case, with stray spaces. */
export function normaliseEmail(raw: string, pattern: RegExp = EMAIL_DEFAULT): string | null {
  const t = raw.replace(/\s+/g, "").toLowerCase();
  const e = t.includes("@") ? t : `${t}@goa.bits-pilani.ac.in`;
  return pattern.test(e) ? e : null;
}

/** Spoken size shown under the input so miscounted zeros are obvious: 250000 -> "2.5 lakh". */
export function inWords(n: number): string {
  const fmt = (x: number) => String(Number(x.toPrecision(3)));
  if (n >= 1e7) return `${fmt(n / 1e7)} crore`;
  if (n >= 1e5) return `${fmt(n / 1e5)} lakh`;
  if (n >= 1e3) return `${fmt(n / 1e3)} thousand`;
  return fmt(n);
}

/** A player's display name: trimmed, single spaces, 2–40 characters, at least one letter. Null if unusable. */
export function cleanName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const t = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 40) return null;
  if (!/\p{L}/u.test(t)) return null;
  if (!/^[\p{L}\p{M}\p{N} .'’\-_]+$/u.test(t)) return null;
  return t;
}
