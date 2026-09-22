import { DEFAULT_OTLP_ENDPOINT } from "@invariant/otel-export";
import type { InvariantConfig } from "../schema/config.js";

/** Expand ${VAR} from the environment; an unset variable expands to "". */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

export interface ResolvedEndpoint {
  endpoint: string;
  source: "--endpoint" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "invariant.config.yaml export.otel_endpoint" | "default";
}

/**
 * Where to send spans: --endpoint, then OTEL_EXPORTER_OTLP_ENDPOINT, then
 * export.otel_endpoint in invariant.config.yaml (${VAR}-expanded), then the OTel default
 * http://localhost:4318. Empty values count as unset at every step.
 */
export function resolveOtelEndpoint(
  flag: string | undefined,
  config: InvariantConfig | null,
  env: NodeJS.ProcessEnv = process.env
): ResolvedEndpoint {
  if (flag?.trim()) return { endpoint: flag.trim(), source: "--endpoint" };
  const fromEnv = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (fromEnv) return { endpoint: fromEnv, source: "OTEL_EXPORTER_OTLP_ENDPOINT" };
  const configured = config?.export?.otel_endpoint ? expandEnv(config.export.otel_endpoint, env).trim() : "";
  if (configured) return { endpoint: configured, source: "invariant.config.yaml export.otel_endpoint" };
  return { endpoint: DEFAULT_OTLP_ENDPOINT, source: "default" };
}
