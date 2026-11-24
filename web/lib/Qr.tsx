"use client";
import qrcode from "qrcode-generator";

/** A QR code as inline SVG (black modules on white, with a quiet zone so phones scan it off a projector). */
export function Qr({ text, size = 240, className }: { text: string; size?: number; className?: string }) {
  if (!text) return null;
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 4;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + pad} ${y + pad}h1v1h-1z`;
  const box = n + pad * 2;
  return (
    <svg className={className} width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${text}`}>
      <rect width={box} height={box} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
