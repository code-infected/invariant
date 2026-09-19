import { z } from "zod";

export const VariantSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const VariantFixtureSchema = z.object({
  task: z.string().min(1),
  fixture_version: z.number().int().positive(),
  generated_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "generated_at must be a parseable ISO 8601 timestamp",
  }),
  approved_by: z.string().min(1),
  variants: z.array(VariantSchema).min(1),
});

export type VariantFixture = z.infer<typeof VariantFixtureSchema>;
