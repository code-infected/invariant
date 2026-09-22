/**
 * `invariant dashboard`: start the read-only dashboard (packages/dashboard, Next.js) on a
 * trace store. The dashboard opens the store read-only and never migrates or writes it.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { INVARIANT_DIR, REPO_ROOT, TASKS_DIR } from "../lib/paths.js";

export const DASHBOARD_DIR = path.join(REPO_ROOT, "packages", "dashboard");

export interface DashboardOptions {
  port: number;
  /** Trace store directory (the one holding trace.db); defaults to <repo>/.invariant. */
  store?: string;
  hostname?: string;
}

export async function runDashboard(opts: DashboardOptions): Promise<number> {
  const store = path.resolve(opts.store ?? INVARIANT_DIR);
  if (!fs.existsSync(path.join(DASHBOARD_DIR, ".next", "BUILD_ID"))) {
    throw new Error(`the dashboard is not built (no ${path.relative(REPO_ROOT, path.join(DASHBOARD_DIR, ".next"))}). Run: npm run build`);
  }
  const require_ = createRequire(path.join(DASHBOARD_DIR, "package.json"));
  const nextBin = require_.resolve("next/dist/bin/next");
  const hostname = opts.hostname ?? "127.0.0.1";
  console.error(`invariant dashboard: http://${hostname}:${opts.port}  (store ${store}, read-only)`);
  const child = spawn(process.execPath, [nextBin, "start", "--port", String(opts.port), "--hostname", hostname], {
    cwd: DASHBOARD_DIR,
    stdio: "inherit",
    env: { ...process.env, INVARIANT_STORE: store, INVARIANT_TASKS_DIR: TASKS_DIR, NEXT_TELEMETRY_DISABLED: "1" },
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}
