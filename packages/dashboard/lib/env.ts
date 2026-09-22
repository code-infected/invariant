import path from "node:path";

/**
 * Where the dashboard reads from. `invariant dashboard` sets both; `npm run dashboard`
 * (cwd packages/dashboard) falls back to the repo's default store and tasks/.
 */
export function storeRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.INVARIANT_STORE ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../../.invariant"));
}

export function tasksDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.INVARIANT_TASKS_DIR ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../../tasks"));
}
