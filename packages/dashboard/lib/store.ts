import fs from "node:fs";
import path from "node:path";
import { isScriptedStandIn, openTraceStore, StoreNotFoundError, StoreOutdatedError, type TraceStore } from "@invariant/trace-store";

/** Written by `invariant demo-seed` into the store root. */
export const DEMO_MARKER_FILE = "SYNTHETIC_DEMO.json";

export interface DemoMarker {
  synthetic: true;
  generator: string;
  created_at: string;
  note: string;
}

export type StoreState =
  | { kind: "ok"; root: string; store: TraceStore; demo: DemoMarker | null }
  | { kind: "missing"; root: string }
  | { kind: "outdated"; root: string; message: string }
  | { kind: "error"; root: string; message: string };

export function readDemoMarker(root: string): DemoMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, DEMO_MARKER_FILE), "utf8"));
    return raw && raw.synthetic === true ? (raw as DemoMarker) : null;
  } catch {
    return null;
  }
}

/** Open the store read-only. Never creates, migrates or writes anything. */
export function openStore(root: string): StoreState {
  try {
    const store = openTraceStore({ root, readonly: true });
    return { kind: "ok", root, store, demo: readDemoMarker(root) };
  } catch (err) {
    if (err instanceof StoreNotFoundError) return { kind: "missing", root };
    if (err instanceof StoreOutdatedError) return { kind: "outdated", root, message: err.message };
    return { kind: "error", root, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Run `fn` against an open store and always close it. */
export function withStore<T>(root: string, fn: (state: StoreState) => T): T {
  const state = openStore(root);
  try {
    return fn(state);
  } finally {
    if (state.kind === "ok") state.store.close();
  }
}

/** True when any fingerprint in the store was reported by the scripted stand-in. */
export function storeHasSyntheticRuns(store: TraceStore): boolean {
  return store.listDeploymentFingerprints().some((f) => isScriptedStandIn(f.model_version));
}
