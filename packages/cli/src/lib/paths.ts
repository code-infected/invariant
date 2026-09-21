import path from "node:path";
import { fileURLToPath } from "node:url";

// packages/cli/src/lib/paths.ts -> repo root is four levels up (src/lib -> src -> cli -> packages -> root)
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../../../");
export const TASKS_DIR = path.join(REPO_ROOT, "tasks");

export function taskSpecPath(name: string): string {
  return path.join(TASKS_DIR, `${name}.yaml`);
}

export function variantFixturePath(name: string): string {
  return path.join(TASKS_DIR, `${name}.variants.json`);
}

/** Runtime data (trace db, raw traces, scratch proxy configs). Gitignored, never source. */
export const INVARIANT_DIR = path.join(REPO_ROOT, ".invariant");

/** Project config (internal-docs/TECHNICAL_SPEC.md section 6). */
export const CONFIG_PATH = path.join(REPO_ROOT, "invariant.config.yaml");
