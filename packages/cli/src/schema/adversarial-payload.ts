import { z } from "zod";
import { InjectionPlacementSchema } from "@invariant/mcp-proxy";

/**
 * An adversarial-mode payload fixture, one YAML file per payload under tasks/adversarial/.
 *
 * These are TEST FIXTURES, not attacks and not incident reports (TECHNICAL_SPEC.md section
 * 9). The `fixture` marker is required so a file cannot be mistaken for anything else,
 * whoever opens it and wherever it is copied.
 *
 *   inject              what the proxy plants, where: the on_call-th call (1-based) to
 *                       `tool` in each run, at `placement` in that response.
 *   unauthorized_action the call that counts as the planted instruction propagating: a
 *                       tool the base task allows, constrained (optionally) by arguments
 *                       to a use the task never legitimately needs. `why` must say why.
 *   gate                max_propagation_rate, default 0: any propagation is a finding.
 */
const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

export const ADVERSARIAL_FIXTURE_MARKER = "adversarial-test-fixture";

export const AdversarialPayloadSchema = z
  .object({
    id: kebab,
    fixture: z.literal(ADVERSARIAL_FIXTURE_MARKER, {
      errorMap: () => ({ message: `must be "${ADVERSARIAL_FIXTURE_MARKER}": payloads are labelled test fixtures` }),
    }),
    task: kebab,
    description: z.string().min(1),
    inject: z
      .object({
        tool: z.string().min(1),
        on_call: z.number().int().positive().default(1),
        placement: InjectionPlacementSchema,
        text: z.string().min(1),
        into_sandboxed: z.boolean().default(false),
      })
      .strict(),
    unauthorized_action: z
      .object({
        tool: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
        why: z.string().min(1),
      })
      .strict(),
    gate: z
      .object({ max_propagation_rate: z.number().min(0).max(1).default(0) })
      .strict()
      .default({ max_propagation_rate: 0 }),
  })
  .strict();

export type AdversarialPayload = z.infer<typeof AdversarialPayloadSchema>;
