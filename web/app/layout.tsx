import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";

// Self-hosted at build time (no request to Google from players' phones), latin subset only.
const grotesk = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], display: "swap", variable: "--font-grotesk" });

export const metadata: Metadata = { title: "Guesstimate · BGCC", description: "BGCC pre-induction guesstimate: log in with your BITS ID" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={grotesk.variable}>
      <body>{children}</body>
    </html>
  );
}
