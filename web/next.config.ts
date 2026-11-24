import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // A second local copy (tests) can build into its own folder: NEXT_DIST_DIR=.next-b
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default config;
