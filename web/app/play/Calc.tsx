"use client";
import { useState } from "react";
import { formatIndian } from "@/lib/parse";

// A tiny on-screen calculator for the guesstimate. Buttons only (no phone keyboard popping up),
// no eval: a small recursive-descent parser over + − × ÷ and brackets.

const OPS = "+-×÷";

/** Evaluates the expression; null if it is incomplete or invalid. */
export function evaluate(src: string): number | null {
  let i = 0;
  const peek = () => src[i];
  function num(): number | null {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  }
  function atom(): number | null {
    if (peek() === "-") { i++; const v = atom(); return v === null ? null : -v; }
    if (peek() === "(") {
      i++;
      const v = sum();
      if (v === null) return null;
      if (peek() === ")") i++; // an unclosed bracket is closed at the end
      return v;
    }
    return num();
  }
  function product(): number | null {
    let v = atom();
    while (v !== null && (peek() === "×" || peek() === "÷")) {
      const op = src[i++];
      const r = atom();
      if (r === null) return null;
      v = op === "×" ? v * r : v / r;
    }
    return v;
  }
  function sum(): number | null {
    let v = product();
    while (v !== null && (peek() === "+" || peek() === "-")) {
      const op = src[i++];
      const r = product();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  if (!src) return null;
  const v = sum();
  return v !== null && i === src.length && Number.isFinite(v) ? v : null;
}

/** Rounded to 2 decimals so it fits the answer box (max 15 digits, one decimal point). */
const tidy = (v: number) => Math.round(v * 100) / 100;

// Stays open from one question to the next once a player opens it.
let keepOpen = false;

const KEYS = ["C", "⌫", "(", ")", "7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "-", "0", "000", ".", "+"];

export function Calc({ onUse }: { onUse: (v: string) => void }) {
  const [open, setOpenState] = useState(keepOpen);
  const setOpen = (v: boolean) => { keepOpen = v; setOpenState(v); };
  const [expr, setExpr] = useState("");
  const [fresh, setFresh] = useState(false); // just pressed "=": a digit starts a new sum

  const result = evaluate(expr);
  const usable = result !== null && result >= 0 && tidy(result) <= 1e15;

  function press(k: string) {
    if (k === "C") { setExpr(""); setFresh(false); return; }
    if (k === "⌫") { setExpr((e) => e.slice(0, -1)); setFresh(false); return; }
    if (k === "=") {
      if (result !== null) { setExpr(String(tidy(result))); setFresh(true); }
      return;
    }
    setExpr((e) => {
      const last = e.slice(-1);
      if (/[\d.(]/.test(k) && fresh) e = "";
      if (OPS.includes(k)) {
        if (k === "-" && (e === "" || last === "(")) return e + k; // a minus sign
        if (e === "" || last === "(") return e;
        if (OPS.includes(last)) return e.slice(0, -1) + k; // swap the operator
      }
      if (k === ".") {
        const tail = /[\d.]*$/.exec(e)![0];
        if (tail.includes(".")) return e;
        if (tail === "") return e + "0.";
      }
      if (k === ")") {
        const depth = (e.match(/\(/g)?.length ?? 0) - (e.match(/\)/g)?.length ?? 0);
        if (depth <= 0 || OPS.includes(last) || last === "(") return e;
      }
      if ((k === "(" || /\d/.test(k)) && last === ")") return e + "×" + k;
      if (k === "(" && /[\d.]/.test(last)) return e + "×(";
      if (e.length >= 80) return e;
      return e + k;
    });
    setFresh(false);
  }

  if (!open) return <button type="button" className="calc-toggle" onClick={() => setOpen(true)}>Calculator</button>;

  return (
    <div className="calc">
      <div className="calc-top">
        <span className="small muted">Calculator</span>
        <button type="button" className="link" onClick={() => setOpen(false)}>Hide</button>
      </div>
      <div className="calc-screen" aria-live="polite">
        <div className="calc-expr">{expr.replace(/-/g, "−") || "0"}</div>
        <div className="calc-res">{result !== null ? `= ${formatIndian(tidy(result))}` : expr ? "…" : " "}</div>
      </div>
      <div className="calc-keys">
        {KEYS.map((k) => (
          <button type="button" key={k} className={OPS.includes(k) ? "op" : k === "C" || k === "⌫" ? "fn" : ""} onClick={() => press(k)}>
            {k === "-" ? "−" : k}
          </button>
        ))}
        <button type="button" className="eq" onClick={() => press("=")}>=</button>
        <button type="button" className="use" disabled={!usable} onClick={() => usable && onUse(String(tidy(result!)))}>Use as my answer</button>
      </div>
    </div>
  );
}
