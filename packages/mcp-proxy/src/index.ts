import path from "node:path";
import { fileURLToPath } from "node:url";

export { createProxy, InvariantProxy, normalizeToolResponse } from "./proxy.js";
export type { ProxyOptions, ProxyToolCallRecord, ToolCallRecorder } from "./proxy.js";
export { injectIntoResult, parseFieldPath, type InjectionOutcome } from "./inject.js";
export {
  ProxyConfigSchema,
  UpstreamConfigSchema,
  DangerousToolSchema,
  InjectionSchema,
  InjectionPlacementSchema,
} from "./config.js";
export type { ProxyConfig, UpstreamConfig, DangerousTool, Injection, InjectionInput, InjectionPlacement } from "./config.js";

/** Absolute path to the proxy's standalone entrypoint, for callers that spawn it. */
export function proxyBinPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "bin.js");
}
