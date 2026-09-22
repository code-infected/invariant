/**
 * Deployment fingerprints (ARCHITECTURE.md section 6).
 *
 * A fingerprint identifies "what was deployed" for one run: the model that answered, the
 * system prompt it was given, and the exact tool surface the proxy exposed to it. Two runs
 * with the same fingerprint were measured against the same deployment; a consistency
 * score over runs with different fingerprints is partly measuring the deploy, not the
 * agent, which is why a batch with more than one fingerprint is flagged.
 *
 * Components
 *   provider       which provider served the model (e.g. "anthropic", "openai", "ollama").
 *                  The same model id can be served by several providers (a Llama model on
 *                  groq, together, or a local ollama) and they are different deployments.
 *   endpoint       host (and port) of the endpoint that answered, e.g. "api.openai.com",
 *                  "localhost:11434". Host only: never a path, a query or credentials.
 *   model_name     the model id the harness asked for (the part after "provider:").
 *   model_version  the model id the API reported answering with (the response's `model`).
 *                  Kept separately because an alias can resolve to a new snapshot with no
 *                  change on the harness side, and that is exactly the change to catch.
 *   system_prompt  the system prompt text, when the harness can see it (null otherwise).
 *   tool_schema    the tool list exactly as the proxy exposed it: name, description and
 *                  input JSON schema of every tool, in the order served.
 *
 * Canonicalisation: object keys are sorted at every depth before hashing, so the same
 * schema serialised with a different key order hashes identically. Array order is kept,
 * including the order of the tool list itself: the model sees the tools in that order, so
 * a reordering is a (small) change to what was deployed, and the fingerprint says so
 * rather than deciding on the model's behalf that it cannot matter.
 *
 * hash (v2) = sha256 over the canonical JSON of
 *   { format, provider, endpoint, model_name, model_version, system_prompt_hash, tool_schema_hash }
 * where the two component hashes are sha256 over the prompt text and the canonical tool
 * schema. The components are stored beside the hash (TraceStore.recordDeploymentFingerprint)
 * so a reader can see which part changed between two fingerprints, not only that one did.
 *
 * Formula versions. v1 (before provider and endpoint were components) hashed
 *   { format: "invariant.fingerprint/v1", model_name, model_version, system_prompt_hash, tool_schema_hash }.
 * Every stored fingerprint records its fingerprint_version; v1 rows keep their v1 hash
 * forever (it is what their runs point at), with provider and endpoint null: not recorded,
 * which is the truth about them. Because the same deployment hashes differently under v1
 * and v2, comparing two fingerprints goes through compareDeployments, which compares only
 * the components both sides recorded. A hash change whose recorded components are all
 * equal is a formula change, not a deployment change, and every reader (score, gate,
 * dashboard trend) says so instead of flagging a deploy.
 */
import { createHash } from "node:crypto";

/** Bumped if the hashing recipe ever changes, so old and new hashes never collide silently. */
export const FINGERPRINT_VERSION = 2;
export const FINGERPRINT_FORMAT = "invariant.fingerprint/v2";
export const FINGERPRINT_FORMAT_V1 = "invariant.fingerprint/v1";

export interface FingerprintInput {
  /** Null (or omitted) when not known, e.g. a trace file from an adapter that does not say. */
  provider?: string | null;
  /** Host[:port] only. Null (or omitted) when not known. */
  endpoint?: string | null;
  model_name: string;
  model_version: string;
  /** Null when the system prompt is not accessible to the harness. */
  system_prompt: string | null;
  /** The tools as exposed to the agent, in the order served. */
  tool_schema: unknown;
}

export interface DeploymentFingerprint {
  hash: string;
  /** Which hashing formula produced `hash` (1 or 2). */
  fingerprint_version: number;
  provider: string | null;
  endpoint: string | null;
  model_name: string;
  model_version: string;
  system_prompt_hash: string | null;
  tool_schema_hash: string;
  system_prompt: string | null;
  /** canonicalJson(tool_schema): the exact tool surface, re-parseable. */
  tool_schema_json: string;
}

/**
 * JSON with object keys sorted at every level; arrays keep their order. Same rule as the
 * scoring engine's canonicalJson, duplicated here rather than imported so the store does
 * not depend on the scorer.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Keep only host[:port], whatever the caller passed; credentials and paths never reach the store. */
export function normalizeEndpoint(endpoint: string | null | undefined): string | null {
  if (endpoint === null || endpoint === undefined || endpoint.trim() === "") return null;
  const text = endpoint.trim();
  try {
    return new URL(text.includes("://") ? text : `http://${text}`).host || null;
  } catch {
    return null;
  }
}

/** The current (v2) fingerprint. */
export function computeDeploymentFingerprint(input: FingerprintInput): DeploymentFingerprint {
  const toolSchemaJson = canonicalJson(input.tool_schema ?? []);
  const systemPromptHash = input.system_prompt === null ? null : sha256(input.system_prompt);
  const toolSchemaHash = sha256(toolSchemaJson);
  const provider = input.provider ?? null;
  const endpoint = normalizeEndpoint(input.endpoint);
  const hash = sha256(
    canonicalJson({
      format: FINGERPRINT_FORMAT,
      provider,
      endpoint,
      model_name: input.model_name,
      model_version: input.model_version,
      system_prompt_hash: systemPromptHash,
      tool_schema_hash: toolSchemaHash,
    })
  );
  return {
    hash,
    fingerprint_version: FINGERPRINT_VERSION,
    provider,
    endpoint,
    model_name: input.model_name,
    model_version: input.model_version,
    system_prompt_hash: systemPromptHash,
    tool_schema_hash: toolSchemaHash,
    system_prompt: input.system_prompt,
    tool_schema_json: toolSchemaJson,
  };
}

/**
 * The v1 formula, kept only to document and test that stored v1 hashes are what they
 * always were. Nothing writes v1 fingerprints any more.
 */
export function computeDeploymentFingerprintV1(input: FingerprintInput): DeploymentFingerprint {
  const toolSchemaJson = canonicalJson(input.tool_schema ?? []);
  const systemPromptHash = input.system_prompt === null ? null : sha256(input.system_prompt);
  const toolSchemaHash = sha256(toolSchemaJson);
  const hash = sha256(
    canonicalJson({
      format: FINGERPRINT_FORMAT_V1,
      model_name: input.model_name,
      model_version: input.model_version,
      system_prompt_hash: systemPromptHash,
      tool_schema_hash: toolSchemaHash,
    })
  );
  return {
    hash,
    fingerprint_version: 1,
    provider: null,
    endpoint: null,
    model_name: input.model_name,
    model_version: input.model_version,
    system_prompt_hash: systemPromptHash,
    tool_schema_hash: toolSchemaHash,
    system_prompt: input.system_prompt,
    tool_schema_json: toolSchemaJson,
  };
}

/** Which components differ between two fingerprints, in a fixed order. */
export type FingerprintComponent = "provider" | "endpoint" | "model_name" | "model_version" | "system_prompt" | "tool_schema";

export const FINGERPRINT_COMPONENTS: readonly FingerprintComponent[] = [
  "provider",
  "endpoint",
  "model_name",
  "model_version",
  "system_prompt",
  "tool_schema",
];

type Comparable = Pick<DeploymentFingerprint, "model_name" | "model_version" | "system_prompt_hash" | "tool_schema_hash"> &
  Partial<Pick<DeploymentFingerprint, "provider" | "endpoint" | "fingerprint_version">>;

/**
 * Components that differ between two fingerprints. provider and endpoint are compared
 * only when both sides recorded them: a v1 fingerprint (or a trace file that did not say)
 * has them null, meaning "not recorded", which is not evidence of a change.
 */
export function changedComponents(a: Comparable, b: Comparable): FingerprintComponent[] {
  const out: FingerprintComponent[] = [];
  const known = (x: string | null | undefined, y: string | null | undefined) => x !== null && x !== undefined && y !== null && y !== undefined;
  if (known(a.provider, b.provider) && a.provider !== b.provider) out.push("provider");
  if (known(a.endpoint, b.endpoint) && a.endpoint !== b.endpoint) out.push("endpoint");
  if (a.model_name !== b.model_name) out.push("model_name");
  if (a.model_version !== b.model_version) out.push("model_version");
  if (a.system_prompt_hash !== b.system_prompt_hash) out.push("system_prompt");
  if (a.tool_schema_hash !== b.tool_schema_hash) out.push("tool_schema");
  return out;
}

export interface DeploymentComparison {
  /** Recorded components that differ: non-empty means the deployment changed. */
  changed: FingerprintComponent[];
  /** Components one side did not record (provider/endpoint of a v1 fingerprint). */
  unrecorded: FingerprintComponent[];
  /** The two hashes were computed with different formula versions. */
  formula_changed: boolean;
  /** Different hashes, but nothing recorded on both sides differs: not a deployment change. */
  formula_only: boolean;
}

export function compareDeployments(a: Comparable & { hash?: string }, b: Comparable & { hash?: string }): DeploymentComparison {
  const changed = changedComponents(a, b);
  const unrecorded: FingerprintComponent[] = [];
  for (const c of ["provider", "endpoint"] as const) {
    const x = a[c] ?? null;
    const y = b[c] ?? null;
    if ((x === null) !== (y === null)) unrecorded.push(c);
  }
  const formulaChanged = (a.fingerprint_version ?? 1) !== (b.fingerprint_version ?? 1);
  const differentHash = a.hash === undefined || b.hash === undefined ? true : a.hash !== b.hash;
  return { changed, unrecorded, formula_changed: formulaChanged, formula_only: differentHash && changed.length === 0 };
}

/**
 * The scripted stand-in used by the SYNTHETIC fixtures reports a model id containing this
 * marker (e.g. "scripted-stand-in (NOT a model)"). Anything that renders runs uses it to
 * label them synthetic; it is a label for honesty, not a security boundary.
 */
export const SCRIPTED_STAND_IN_MARKER = "scripted-stand-in";

export function isScriptedStandIn(modelVersion: string | null | undefined): boolean {
  return typeof modelVersion === "string" && modelVersion.includes(SCRIPTED_STAND_IN_MARKER);
}
