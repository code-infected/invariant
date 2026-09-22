/**
 * The trial trace file: one JSON file per (variant, trial) cell, written by an adapter
 * that runs the agent outside this process (today: adapters/langgraph, a Python package)
 * and imported by `invariant ingest`.
 *
 * Why a file and not a second writer: the trace store's schema lives in TypeScript
 * (@invariant/trace-store). A Python process writing trace.db directly would be a second
 * implementation of that schema, free to drift from it. Instead adapters describe what
 * happened in this format and `ingest` is the only thing that turns it into rows, through
 * the same TraceStore API the MCP path uses.
 *
 * This Zod schema is the single definition. schemas/trial-trace.v1.schema.json is
 * generated from it (`npm run schema:trial-trace -w @invariant/cli`) and checked in, so
 * non-TypeScript adapters can validate what they write; a test fails if the checked-in
 * file and this schema disagree. The JSON Schema covers shape only. Checks that need the
 * task spec, the variant fixture, or the other files of the same batch (sequence indices
 * contiguous, dangerous tools sandboxed, a complete run matrix...) are made by ingest.
 *
 * Versioning: `format` names the version. Any change a v1 reader would misread (a new
 * required field, a changed meaning) is a new version and a new schema file, never an
 * edit to this one in place.
 */
import { z } from "zod";

export const TRIAL_TRACE_FORMAT = "invariant.trial-trace/v1";

const timestamp = z.string().datetime({ offset: true }).describe("ISO 8601 timestamp");

const jsonValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

/** TECHNICAL_SPEC.md section 3, minus run_id: the store assigns run ids when a file is ingested. */
export const TraceToolCallSchema = z
  .object({
    sequence_index: z.number().int().nonnegative().describe("0-based order of the call within the run"),
    tool_name: z.string().min(1),
    args: z.record(z.string(), z.unknown()).describe("Arguments exactly as the agent sent them, before any masking"),
    response: jsonValue.describe(
      "What the tool returned: its JSON payload when the result was a single JSON text, the text otherwise. " +
        "A failed call is recorded as {isError: true, content: [{type: 'text', text}]}, like an MCP error result."
    ),
    is_sandboxed: z.boolean().describe("True when the call was answered with the task's sandbox_response and the real tool never ran"),
    timestamp,
  })
  .strict();

export const ToolSchemaEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const TrialTraceSchema = z
  .object({
    format: z.literal(TRIAL_TRACE_FORMAT),
    adapter: z
      .object({
        name: z.string().min(1).describe("e.g. invariant-langgraph"),
        version: z.string().min(1),
        framework: z.record(z.string(), z.string()).describe("Versions of the agent framework packages the trial ran on"),
      })
      .strict(),
    task: z.string().min(1).describe("tasks/<task>.yaml"),
    tier: z.enum(["smoke", "full"]),
    batch: z
      .object({
        key: z.string().min(1).describe("Adapter-chosen id shared by every file of one batch; ingest refuses to mix keys"),
        trials_per_variant: z.number().int().positive(),
        variants_requested: z.number().int().positive(),
        variant_labels: z.array(z.string().min(1)).min(1).describe("Fixture labels the batch ran, in fixture order"),
      })
      .strict(),
    variant: z
      .object({
        id: z.string().min(1),
        text: z.string().min(1).describe("The phrasing sent to the agent; must equal the fixture's text"),
        fixture_version: z.number().int().positive(),
      })
      .strict(),
    trial: z.number().int().positive(),
    status: z.enum(["ok", "timeout", "infra_error"]),
    stop_reason: z.enum(["reply_to_user", "end_turn", "max_turns", "wall_clock_timeout", "error"]),
    error: z
      .object({
        kind: z.enum(["provider", "provider_rejected", "harness"]),
        message: z.string(),
        http_status: z.number().int().optional(),
      })
      .strict()
      .nullable(),
    final_output: z.string().nullable(),
    started_at: timestamp,
    finished_at: timestamp,
    latency_ms: z.number().int().nonnegative(),
    usage: z
      .object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
      .strict(),
    fingerprint: z
      .object({
        model_name: z.string().min(1).describe("The model id the adapter asked for"),
        model_version: z.string().min(1).describe("The model id the provider reported answering with"),
        system_prompt: z.string().nullable(),
        tool_schema: z.array(ToolSchemaEntrySchema).describe("The tools as exposed to the agent, in order"),
      })
      .strict()
      .nullable()
      .describe("Deployment fingerprint components; null when no model response arrived. Ingest computes the hash."),
    tool_calls: z.array(TraceToolCallSchema),
    messages: z.array(z.unknown()).optional().describe("Optional transcript, kept in the raw trace only"),
  })
  .strict();

export type TrialTrace = z.infer<typeof TrialTraceSchema>;
export type TraceToolCall = z.infer<typeof TraceToolCallSchema>;
