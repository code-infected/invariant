import { z } from "zod";
import { KNOWN_PROVIDERS, parseModelRef, PROVIDERS } from "@invariant/providers";

/**
 * invariant.config.yaml (internal-docs/TECHNICAL_SPEC.md section 6).
 *
 * Only the keys something actually reads are validated strictly; the rest of the file
 * (e.g. storage) passes through untouched until the code that uses it exists, so a
 * config written for a later milestone does not fail validation today.
 */
/**
 * An HTTP status, "timeout" (a provider failure with no HTTP response), or a provider's own
 * error code matched by name (e.g. "ThrottlingException", "RESOURCE_EXHAUSTED"). Codes only
 * widen what is retried among failures already classified as infra; see retry.ts.
 */
export const RetryOnSchema = z.union([
  z.number().int().min(100).max(599),
  z.literal("timeout"),
  z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, 'a provider error code (letters, digits, "_", "-", "."), "timeout", or an HTTP status number'),
]);

/**
 * One model role (models.agent / judge / paraphraser / embedder):
 *   model        "provider:model", split on the first colon (ollama:qwen2.5:3b is fine).
 *   base_url     overrides the provider's default endpoint; required for azure, vllm and
 *                openai-compatible.
 *   api_key_env  the environment variable holding the key, overriding the provider's
 *                conventional one. A name, never the key itself.
 *   params       model parameters, sent exactly as written (temperature, top_p,
 *                max_tokens and stop are mapped to each provider's field; any other key is
 *                passed through). Nothing is set on the agent under test unless it is here.
 *   api_version  azure only: use the dated /deployments route instead of the v1 API.
 *   region       bedrock only.
 */
export const ModelRoleSchema = z
  .object({
    model: z.string().min(1),
    base_url: z.string().url().optional(),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be the NAME of an environment variable (the key itself never goes in this file)")
      .optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    api_version: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    let provider: string;
    try {
      provider = parseModelRef(m.model).provider;
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: (err as Error).message });
      return;
    }
    const info = PROVIDERS[provider]!;
    if (info.base_url_required && !m.base_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["base_url"], message: `provider ${provider} needs base_url` });
    }
    if (m.api_version !== undefined && provider !== "azure") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["api_version"], message: `api_version applies to provider azure only` });
    }
    if (m.region !== undefined && provider !== "bedrock") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["region"], message: `region applies to provider bedrock only` });
    }
  });

export const MODEL_ROLES = ["agent", "judge", "paraphraser", "embedder"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Every model call the harness makes, by role. Each role is optional here so a config can
 * leave out what it does not use (no paraphraser in CI, no embedder at all); a command
 * that needs a role it cannot find says so and names the key. The shipped config and the
 * `init` template state every default explicitly: there are no hidden model defaults in code.
 */
export const ModelsConfigSchema = z
  .object({
    agent: ModelRoleSchema.optional(),
    judge: ModelRoleSchema.optional(),
    paraphraser: ModelRoleSchema.optional(),
    embedder: ModelRoleSchema.optional(),
  })
  .strict()
  .superRefine((models, ctx) => {
    if (models.judge?.params && "temperature" in models.judge.params) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["judge", "params", "temperature"],
        message: "set the judge's temperature with judge.temperature (the judge's scoring setting), not models.judge.params",
      });
    }
    if (models.embedder) {
      try {
        const { provider } = parseModelRef(models.embedder.model);
        if (!PROVIDERS[provider]!.embeddings) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["embedder", "model"],
            message: `provider ${provider} has no embeddings API in invariant; use one of ${KNOWN_PROVIDERS.filter((p) => PROVIDERS[p]!.embeddings).join(", ")}`,
          });
        }
      } catch {
        // reported by ModelRoleSchema
      }
    }
  });

/**
 * The outcome-axis judge's scoring settings. Every key is optional so a config without a
 * judge section still works; the defaults are the ones the design fixes (temperature 0,
 * majority of 3, the 0.95 / 0.40 pre-filter band). Which model judges is models.judge; the
 * pre-filter thresholds apply only when models.embedder is configured.
 */
export const JudgeConfigSchema = z
  .object({
    model: z
      .never({
        errorMap: () => ({ message: 'the judge model moved to models.judge.model (e.g. models: { judge: { model: "anthropic:claude-sonnet-4-5" } })' }),
      })
      .optional(),
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
    models: ModelsConfigSchema.default({}),
    export: ExportConfigSchema.optional(),
  })
  .passthrough();

export type InvariantConfig = z.infer<typeof InvariantConfigSchema>;
