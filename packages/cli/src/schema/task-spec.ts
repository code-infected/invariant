import { z } from "zod";

export const DangerousToolSchema = z.object({
  name: z.string(),
  sandbox_response: z.string(),
});

export const ThresholdsSchema = z.object({
  outcome_consistency_min: z.number().min(0).max(1),
  tool_path_consistency_min: z.number().min(0).max(1),
  // Not forced to exactly 1.0 in the schema so a task author can consciously
  // relax it, but validate.ts warns loudly when it's below 1.0 (see NOTES
  // in ARCHITECTURE.md): this is the axis that maps directly to real harm.
  state_mutation_consistency: z.number().min(0).max(1),
});

export const ExecutionConfigSchema = z.object({
  max_wall_clock_seconds: z.number().positive(),
  trials_smoke: z.number().int().positive(),
  trials_full: z.number().int().positive(),
  variants_smoke: z.number().int().positive(),
  variants_full: z.number().int().positive(),
});

export const AdversarialConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

export const TaskSpecSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case, e.g. refund-duplicate-check"),
    description: z.string().min(1),
    prompt_template: z.string().min(1),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    success_rubric: z.string().min(1),
    tools: z.object({
      allowed: z.array(z.string()).min(1),
      dangerous: z.array(DangerousToolSchema).default([]),
    }),
    volatile_fields: z.array(z.string()).default([]),
    thresholds: ThresholdsSchema,
    execution: ExecutionConfigSchema,
    adversarial: AdversarialConfigSchema.default({ enabled: false }),
  })
  .superRefine((spec, ctx) => {
    const allowed = new Set(spec.tools.allowed);
    for (const dangerous of spec.tools.dangerous) {
      if (!allowed.has(dangerous.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dangerous tool "${dangerous.name}" is not listed in tools.allowed`,
          path: ["tools", "dangerous"],
        });
      }
    }
  });

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
