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
 *   model_name     the model id the harness asked for (the request's `model`).
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
 * hash = sha256 over the canonical JSON of
 *   { format, model_name, model_version, system_prompt_hash, tool_schema_hash }
 * where the two component hashes are sha256 over the prompt text and the canonical tool
 * schema. The components are stored beside the hash (TraceStore.recordDeploymentFingerprint)
 * so a reader can see which part changed between two fingerprints, not only that one did.
 */
import { createHash } from "node:crypto";

/** Bumped if the hashing recipe ever changes, so old and new hashes never collide silently. */
export const FINGERPRINT_FORMAT = "invariant.fingerprint/v1";

export interface FingerprintInput {
  model_name: string;
  model_version: string;
  /** Null when the system prompt is not accessible to the harness. */
  system_prompt: string | null;
  /** The tools as exposed to the agent, in the order served. */
  tool_schema: unknown;
}

export interface DeploymentFingerprint {
  hash: string;
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

export function computeDeploymentFingerprint(input: FingerprintInput): DeploymentFingerprint {
  const toolSchemaJson = canonicalJson(input.tool_schema ?? []);
  const systemPromptHash = input.system_prompt === null ? null : sha256(input.system_prompt);
  const toolSchemaHash = sha256(toolSchemaJson);
  const hash = sha256(
    canonicalJson({
      format: FINGERPRINT_FORMAT,
      model_name: input.model_name,
      model_version: input.model_version,
      system_prompt_hash: systemPromptHash,
      tool_schema_hash: toolSchemaHash,
    })
  );
  return {
    hash,
    model_name: input.model_name,
    model_version: input.model_version,
    system_prompt_hash: systemPromptHash,
    tool_schema_hash: toolSchemaHash,
    system_prompt: input.system_prompt,
    tool_schema_json: toolSchemaJson,
  };
}

/** Which components differ between two fingerprints, in a fixed order. */
export type FingerprintComponent = "model_name" | "model_version" | "system_prompt" | "tool_schema";

export function changedComponents(
  a: Pick<DeploymentFingerprint, "model_name" | "model_version" | "system_prompt_hash" | "tool_schema_hash">,
  b: Pick<DeploymentFingerprint, "model_name" | "model_version" | "system_prompt_hash" | "tool_schema_hash">
): FingerprintComponent[] {
  const out: FingerprintComponent[] = [];
  if (a.model_name !== b.model_name) out.push("model_name");
  if (a.model_version !== b.model_version) out.push("model_version");
  if (a.system_prompt_hash !== b.system_prompt_hash) out.push("system_prompt");
  if (a.tool_schema_hash !== b.tool_schema_hash) out.push("tool_schema");
  return out;
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
