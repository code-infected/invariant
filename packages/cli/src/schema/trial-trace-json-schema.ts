import { zodToJsonSchema } from "zod-to-json-schema";
import { TRIAL_TRACE_FORMAT, TrialTraceSchema } from "./trial-trace.js";

/** Repo-relative path of the checked-in JSON Schema generated from TrialTraceSchema. */
export const TRIAL_TRACE_SCHEMA_FILE = "schemas/trial-trace.v1.schema.json";

/** The JSON Schema for TrialTraceSchema, as checked in (with a trailing newline). */
export function trialTraceJsonSchema(): string {
  const generated = zodToJsonSchema(TrialTraceSchema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  const schema = {
    $schema,
    $id: "urn:invariant:schema:trial-trace:v1",
    title: TRIAL_TRACE_FORMAT,
    description:
      "One trial of one variant of an invariant task, written by an out-of-process adapter and imported with " +
      "`invariant ingest`. GENERATED from packages/cli/src/schema/trial-trace.ts; do not edit by hand.",
    ...rest,
  };
  return JSON.stringify(schema, null, 2) + "\n";
}
