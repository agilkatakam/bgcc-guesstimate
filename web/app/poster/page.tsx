"use client";
import { useEffect, useState } from "react";
import { Qr } from "@/lib/Qr";

// Printable A4 poster for marketing: open /poster on the real site and print (or save as PDF).
export default function Poster() {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(`${window.location.origin}/play`), []);
  const short = url.replace(/^https?:\/\//, "");
  return (
    <main className="poster">
      <div className="ptop">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="BGCC: BITS Goa Consulting Club" />
        <span>BGCC · Pre-induction</span>
      </div>
      <p className="pkick">Round 1 · Guesstimate</p>
      <h1>How many?<br />Guess it.<br />Beat everyone.</h1>
      <div className="pqr">{url && <Qr text={url} size={300} />}</div>
      <p className="purl">{short}</p>
      <p className="pnote">Log in now with your BITS ID, your name and a 4-digit PIN. You&apos;ll stay logged in for the game.</p>
      <button className="primary noprint" onClick={() => window.print()}>Print / save as PDF</button>
      <style>{`
        @page { size: A4; margin: 0; }
        .poster { min-height: 100vh; max-width: 210mm; margin: 0 auto; padding: 14mm 14mm; background: #000; color: #fff; display: flex; flex-direction: column; gap: 6mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .ptop { display: flex; align-items: center; gap: 4mm; font: 700 14px var(--mono); letter-spacing: .14em; text-transform: uppercase; border-bottom: 3px solid #fff; padding-bottom: 4mm; }
        .ptop img { height: 16mm; width: auto; }
        .pkick { font: 700 16px var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--y); margin: 0; }
        .poster h1 { font-size: 52px; line-height: .98; margin: 0; text-transform: uppercase; letter-spacing: -.02em; }
        .pqr { align-self: flex-start; border: 4mm solid var(--y); line-height: 0; }
        .pqr svg { width: min(300px, 70vw); height: auto; }
        .purl { font: 700 clamp(18px, 5vw, 28px) var(--mono); color: var(--y); margin: 0; overflow-wrap: anywhere; }
        .pnote { font-size: 20px; margin: 0; max-width: 150mm; }
        @media print { .noprint { display: none; } }
      `}</style>
    </main>
  );
}
