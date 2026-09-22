/**
 * Which model serves each role, from invariant.config.yaml `models:` plus CLI overrides.
 *
 * Overrides (--model, --judge-model) replace the role's model reference. The role's
 * base_url, api_key_env, api_version, region and params are kept only when the override
 * names the same provider; they describe that provider's endpoint and knobs, and carrying
 * them to a different provider would send one provider's settings to another.
 */
import {
  credentialEnvNames,
  credentialStatus,
  missingCredentialMessage,
  parseModelRef,
  PROVIDERS,
  resolveModel,
  type CredentialStatus,
  type ModelSpec,
} from "@invariant/providers";
import { MODEL_ROLES, type InvariantConfig, type ModelRole } from "../schema/config.js";

export { MODEL_ROLES, type ModelRole };

/** Why each role calls a model, for missing-key messages: purpose, and why there is no fallback. */
export const ROLE_PURPOSE: Record<ModelRole, { purpose: string; consequence: string }> = {
  agent: {
    purpose: "Running a trial drives the agent under test through the real model API",
    consequence: "a faked agent response would produce a trace that measures nothing",
  },
  judge: {
    purpose: "The outcome axis asks an LLM judge whether two final answers satisfy the task's rubric",
    consequence: "a faked judge would produce an outcome score that measures nothing",
  },
  paraphraser: {
    purpose: "Variant generation calls an LLM to paraphrase the task prompt",
    consequence: "a fake paraphraser would defeat the point of this command (or write the fixture by hand, see internal-docs/TECHNICAL_SPEC.md section 2)",
  },
  embedder: {
    purpose: "The outcome axis's embedding pre-filter embeds final answers",
    consequence: "fake vectors would decide pairs nobody measured (remove models.embedder to send every pair to the judge instead)",
  },
};

export function roleMissingKeyMessage(role: ModelRole, spec: ModelSpec): string {
  return missingCredentialMessage(spec, ROLE_PURPOSE[role].purpose, ROLE_PURPOSE[role].consequence);
}

/** Apply a CLI override to a configured role (see the module comment). */
export function withOverride(configured: ModelSpec | undefined, override: string | undefined): ModelSpec | undefined {
  if (override === undefined) return configured;
  const next = parseModelRef(override);
  if (!configured) return { model: override };
  const current = parseModelRef(configured.model);
  if (current.provider !== next.provider) return { model: override };
  return { ...configured, model: override };
}

/** The spec for a role, or null when the config does not configure it (and no override does). */
export function roleSpec(config: InvariantConfig, role: ModelRole, override?: string): ModelSpec | null {
  return withOverride(config.models?.[role] as ModelSpec | undefined, override) ?? null;
}

/** The spec for a role a command cannot run without; throws naming the config key. */
export function requireRole(config: InvariantConfig, role: ModelRole, override?: string): ModelSpec {
  const spec = roleSpec(config, role, override);
  if (!spec) {
    throw new Error(
      `no ${role} model configured: set models.${role}.model in invariant.config.yaml ` +
        `(e.g. models: { ${role}: { model: "anthropic:claude-sonnet-4-5" } }) or pass ${role === "judge" ? "--judge-model" : "--model"}=provider:model.`
    );
  }
  return spec;
}

/** Throw the role's missing-key message when its credentials are not set (bedrock: never; the AWS chain decides at call time). */
export function requireCredentials(role: ModelRole, spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): void {
  if (credentialStatus(spec, env).state === "missing") throw new Error(roleMissingKeyMessage(role, spec));
}

export function describeCredentials(spec: ModelSpec, status: CredentialStatus = credentialStatus(spec)): string {
  const { provider } = parseModelRef(spec.model);
  switch (status.state) {
    case "present":
      return `${status.env[0]} is set`;
    case "missing":
      return `${status.env.join(" or ")} ${status.env.length === 1 ? "is" : "are"} NOT set`;
    case "not_needed":
      return status.env.length > 0 ? `no key needed (${status.env.join(" or ")} not set; sent only if set)` : "no key needed";
    case "aws_chain":
      return `AWS credential chain (${PROVIDERS[provider]!.auth.replace(/^the standard AWS credential chain /, "")}); not checked without --ping`;
  }
}

/** Every env variable any configured role reads its key from (for tests and CI). */
export function configuredCredentialEnv(config: InvariantConfig): string[] {
  const names = new Set<string>();
  for (const role of MODEL_ROLES) {
    const spec = roleSpec(config, role);
    if (spec) for (const n of credentialEnvNames(spec)) names.add(n);
  }
  return [...names];
}

/**
 * Remove every credential the configured roles read, returning a function that restores
 * them. For tests that exercise the no-key path whatever provider the config names.
 */
export function clearConfiguredCredentials(config: InvariantConfig, env: NodeJS.ProcessEnv = process.env): () => void {
  const saved = new Map<string, string | undefined>();
  const names = [...configuredCredentialEnv(config), "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"];
  for (const n of names) {
    saved.set(n, env[n]);
    delete env[n];
  }
  return () => {
    for (const [n, v] of saved) if (v === undefined) delete env[n];
    else env[n] = v;
  };
}

/** "openai:gpt-4.1 @ api.openai.com, params {...}" for progress lines. Never a key. */
export function describeAgent(spec: ModelSpec): string {
  let host: string | null = null;
  try {
    host = resolveModel(spec, { env: {} }).endpoint;
  } catch {
    host = null;
  }
  const params = spec.params && Object.keys(spec.params).length > 0 ? `, params ${JSON.stringify(spec.params)}` : ", no params set";
  return `${spec.model}${host ? ` @ ${host}` : ""}${params}`;
}

/** The variable name(s) the judge's missing-key message names, as a regex (tests). */
export function judgeMissingKeyPattern(config: InvariantConfig): RegExp {
  const spec = roleSpec(config, "judge");
  if (!spec) return /no judge model configured/;
  const names = credentialEnvNames(spec);
  return new RegExp(`${names.join(" or ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (is|are) not set`);
}
