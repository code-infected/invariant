import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // The trace store is a local SQLite file read through better-sqlite3 (a native module);
  // it and the workspace package wrapping it are loaded by Node at runtime, never bundled.
  serverExternalPackages: ["better-sqlite3", "@invariant/trace-store"],
  // The workspace root holds the lockfile and the hoisted node_modules.
  turbopack: { root: path.resolve(here, "../..") },
  outputFileTracingRoot: path.resolve(here, "../.."),
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
