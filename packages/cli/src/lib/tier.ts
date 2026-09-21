import type { TaskSpec } from "../schema/task-spec.js";
import type { VariantFixture } from "../schema/variant-fixture.js";

export type Tier = "smoke" | "full";
export const TIERS: readonly Tier[] = ["smoke", "full"];

export interface TierSelection {
  tier: Tier;
  trials: number;
  variants_requested: number;
  /** The variants to run: the first N of the fixture, in fixture order. */
  variants: VariantFixture["variants"];
  /** How many variants the tier asked for that the fixture does not have. */
  shortfall: number;
}

/**
 * Map a tier to concrete counts for one task.
 *
 * Variant selection is the first N by fixture order, never a sample: the fixture is the
 * reviewed, versioned test input (ARCHITECTURE.md, Variant Generator), and a random subset
 * would make two runs of the same tier measure different phrasings. Taking a prefix also
 * means the smoke tier's variants are always a subset of the full tier's.
 *
 * A fixture with fewer variants than the tier wants runs all of them and reports the
 * shortfall rather than repeating phrasings to pad the count: a duplicated phrasing
 * would be counted as cross-variant agreement when it is really cross-trial agreement.
 */
export function selectTier(spec: TaskSpec, fixture: VariantFixture, tier: Tier): TierSelection {
  const trials = tier === "smoke" ? spec.execution.trials_smoke : spec.execution.trials_full;
  const requested = tier === "smoke" ? spec.execution.variants_smoke : spec.execution.variants_full;
  const variants = fixture.variants.slice(0, requested);
  return {
    tier,
    trials,
    variants_requested: requested,
    variants,
    shortfall: requested - variants.length,
  };
}
