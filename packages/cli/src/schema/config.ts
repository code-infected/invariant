import { z } from "zod";

/**
 * invariant.config.yaml (internal-docs/TECHNICAL_SPEC.md section 6).
 *
 * Only the keys something actually reads are validated strictly; the rest of the file
 * (e.g. storage) passes through untouched until the code that uses it exists, so a
 * config written for a later milestone does not fail validation today.
 */
export const RetryOnSchema = z.union([z.number().int().min(100).max(599), z.literal("timeout")]);

/**
 * The outcome-axis judge. Every key is optional so a config without a judge section still
 * works; the defaults are the ones the design fixes (temperature 0, majority of 3, the
 * 0.95 / 0.40 pre-filter band). model defaults to @invariant/scoring's DEFAULT_JUDGE_MODEL.
 * The pre-filter thresholds are read but inert until an embedding provider is wired in.
 */
export const JudgeConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(1).default(0),
    votes: z.number().int().min(1).default(3),
    embedding_prefilter_threshold_high: z.number().min(0).max(1).default(0.95),
    embedding_prefilter_threshold_low: z.number().min(0).max(1).default(0.4),
  })
  .passthrough()
  .refine((j) => j.embedding_prefilter_threshold_low <= j.embedding_prefilter_threshold_high, {
    message: "embedding_prefilter_threshold_low must not exceed embedding_prefilter_threshold_high",
  });

/**
 * OpenTelemetry export (`invariant export`, `invariant run --otel`). otel_endpoint is the
 * OTLP/HTTP base URL; ${VAR} references are expanded from the environment when read, and
 * an empty expansion counts as unset.
 */
export const ExportConfigSchema = z
  .object({
    otel_endpoint: z.string().optional(),
    service_name: z.string().min(1).optional(),
  })
  .passthrough();

export const InvariantConfigSchema = z
  .object({
    providers: z
      .object({
        retry: z
          .object({
            max_attempts: z.number().int().min(1),
            retry_on: z.array(RetryOnSchema),
          })
          .passthrough(),
      })
      .passthrough(),
    execution: z
      .object({
        worker_concurrency: z.number().int().min(1),
        default_tier: z.enum(["smoke", "full"]),
      })
      .passthrough(),
    judge: JudgeConfigSchema.default({}),
    export: ExportConfigSchema.optional(),
  })
  .passthrough();

export type InvariantConfig = z.infer<typeof InvariantConfigSchema>;
