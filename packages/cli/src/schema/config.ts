import { z } from "zod";

/**
 * invariant.config.yaml (internal-docs/TECHNICAL_SPEC.md section 6).
 *
 * Only the keys something actually reads are validated strictly; the rest of the file
 * (judge, storage, export) passes through untouched until the code that uses it exists,
 * so a config written for a later milestone does not fail validation today.
 */
export const RetryOnSchema = z.union([z.number().int().min(100).max(599), z.literal("timeout")]);

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
  })
  .passthrough();

export type InvariantConfig = z.infer<typeof InvariantConfigSchema>;
