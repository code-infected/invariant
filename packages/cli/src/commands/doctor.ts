/**
 * `invariant doctor [--ping] [--roles=agent,judge] [--json]`: for each configured model
 * role, which provider and endpoint it goes to and whether its credentials are present.
 * A key is never printed, not even in part: only the NAME of the variable it was read from.
 *
 * --ping makes one minimal live call per role (a one-word chat, or one embedding) and
 * reports the model id the provider reported and the latency. That spends a few tokens per
 * role; without --ping nothing leaves the machine (for bedrock, the AWS credential chain is
 * resolved locally, which can read ~/.aws or the instance metadata service, but calls no model).
 *
 * Exit code: 0 when every checked role is configured and has credentials (and, with
 * --ping, answered); 1 otherwise. CI runs `invariant doctor --roles=agent,judge` before
 * spending anything.
 */
import { clientFor, credentialStatus, isTemperatureUnsupported, resolveModel, type ModelSpec } from "@invariant/providers";
import { loadConfig } from "../lib/config.js";
import { describeCredentials, MODEL_ROLES, roleMissingKeyMessage, roleSpec, type ModelRole } from "../lib/models.js";
import type { InvariantConfig } from "../schema/config.js";

export interface DoctorOptions {
  ping: boolean;
  /** Roles to check; default: every configured role. Named roles must be configured. */
  roles?: ModelRole[];
  json: boolean;
}

export interface DoctorDeps {
  config?: InvariantConfig;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

export interface RoleCheck {
  role: ModelRole;
  configured: boolean;
  model: string | null;
  provider: string | null;
  endpoint: string | null;
  credentials: "present" | "missing" | "not_needed" | "aws_chain" | "aws_chain_resolved" | "aws_chain_failed" | null;
  /** Human text: which variable, set or not. Never a key. */
  credentials_detail: string;
  ok: boolean;
  problem?: string;
  ping?: {
    ok: boolean;
    latency_ms: number;
    reported_model?: string | null;
    detail?: string;
    error?: string;
  };
}

export interface DoctorReport {
  ok: boolean;
  roles: RoleCheck[];
}

const PING_PROMPT = "Reply with the single word OK.";

async function ping(role: ModelRole, spec: ModelSpec, config: InvariantConfig, env: NodeJS.ProcessEnv): Promise<RoleCheck["ping"]> {
  const started = Date.now();
  try {
    const client = clientFor(spec, { env, missing: (s) => roleMissingKeyMessage(role, s) });
    if (role === "embedder") {
      const res = await client.embed!(["ping"], AbortSignal.timeout(30_000));
      return { ok: true, latency_ms: Date.now() - started, reported_model: res.model, detail: `${res.vectors[0]?.length ?? 0}-dimensional vector` };
    }
    const params: Record<string, unknown> = { max_tokens: 16 };
    if (role === "judge") params.temperature = config.judge.temperature;
    const call = (p: Record<string, unknown>) =>
      client.chat({ system: "", messages: [{ role: "user", content: PING_PROMPT }], tools: [], params: p, signal: AbortSignal.timeout(30_000) });
    let detail: string | undefined;
    let res;
    try {
      res = await call(params);
    } catch (err) {
      if (role !== "judge" || !isTemperatureUnsupported(err)) throw err;
      // What the judge itself would do (and record): one retry without temperature.
      const { temperature: _dropped, ...rest } = params;
      res = await call(rest);
      detail = `temperature ${config.judge.temperature} UNSUPPORTED by this model; the judge will run without it and record that`;
    }
    return {
      ok: true,
      latency_ms: Date.now() - started,
      reported_model: res.model,
      detail: detail ?? `replied ${JSON.stringify(res.text.slice(0, 40))} (stop: ${res.raw_stop_reason ?? "none"})`,
    };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runDoctor(opts: DoctorOptions, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig();
  const roles = opts.roles ?? MODEL_ROLES.filter((r) => roleSpec(config, r) !== null);
  const checks: RoleCheck[] = [];

  for (const role of opts.roles ? roles : MODEL_ROLES) {
    const spec = roleSpec(config, role);
    const selected = roles.includes(role);
    if (!spec) {
      checks.push({
        role,
        configured: false,
        model: null,
        provider: null,
        endpoint: null,
        credentials: null,
        credentials_detail: "",
        ok: !selected,
        ...(selected ? { problem: `models.${role} is not configured in invariant.config.yaml` } : {}),
      });
      continue;
    }
    let check: RoleCheck;
    try {
      const resolved = resolveModel(spec, { env });
      const status = credentialStatus(spec, env);
      check = {
        role,
        configured: true,
        model: spec.model,
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        credentials: status.state,
        credentials_detail: describeCredentials(spec, status),
        ok: status.state !== "missing",
        ...(status.state === "missing" ? { problem: roleMissingKeyMessage(role, spec) } : {}),
      };
      if (status.state === "aws_chain") {
        try {
          await clientFor(spec, { env }).checkCredentials?.();
          check.credentials = "aws_chain_resolved";
          check.credentials_detail = "AWS credential chain: credentials and region resolved (not printed)";
        } catch (err) {
          check.credentials = "aws_chain_failed";
          check.credentials_detail = `AWS credential chain: could not resolve (${err instanceof Error ? err.message : String(err)})`;
          check.ok = false;
          check.problem = "no AWS credentials found by the standard chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, SSO, web identity, instance role) or no region";
        }
      }
    } catch (err) {
      check = {
        role,
        configured: true,
        model: spec.model,
        provider: null,
        endpoint: null,
        credentials: null,
        credentials_detail: "",
        ok: false,
        problem: err instanceof Error ? err.message : String(err),
      };
    }
    if (opts.ping && check.ok && selected) {
      check.ping = await ping(role, spec, config, env);
      if (!check.ping!.ok) check.ok = false;
    }
    if (!selected) check.ok = true;
    checks.push(check);
  }

  const shown = checks.filter((c) => roles.includes(c.role) || c.configured || c.role === "embedder");
  const report: DoctorReport = { ok: checks.filter((c) => roles.includes(c.role)).every((c) => c.ok), roles: shown };

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
    return report;
  }
  out("invariant doctor: model roles from invariant.config.yaml (keys are never printed)");
  out("");
  for (const c of shown) {
    const head = `  ${c.role.padEnd(12)}`;
    if (!c.configured) {
      out(
        `${head}not configured` +
          (c.role === "embedder" ? " (no embedding pre-filter: every non-identical pair of answers goes to the judge)" : "") +
          (roles.includes(c.role) ? "   <- PROBLEM" : "")
      );
      continue;
    }
    out(`${head}${c.model}${c.endpoint ? ` @ ${c.endpoint}` : ""}`);
    if (c.credentials_detail) out(`  ${"".padEnd(12)}credentials: ${c.credentials_detail}`);
    if (c.ping) {
      out(
        c.ping.ok
          ? `  ${"".padEnd(12)}ping: ok in ${c.ping.latency_ms} ms, reported model ${c.ping.reported_model ?? "(not reported by the API)"}${c.ping.detail ? `; ${c.ping.detail}` : ""}`
          : `  ${"".padEnd(12)}ping: FAILED after ${c.ping.latency_ms} ms: ${c.ping.error}`
      );
    }
    if (c.problem) out(`  ${"".padEnd(12)}PROBLEM: ${c.problem}`);
  }
  out("");
  out(report.ok ? "OK" : "NOT OK: fix the problems above before running.");
  if (!opts.ping) out("(credentials checked for presence only; --ping makes one minimal live call per role)");
  return report;
}
