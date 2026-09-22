import type { BatchDeployment, BatchDeploymentFingerprint, TraceStore } from "@invariant/trace-store";

export type BatchFingerprint = BatchDeploymentFingerprint;
export type BatchFingerprintSummary = BatchDeployment;

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function batchFingerprints(store: TraceStore, batchId: string): BatchFingerprintSummary {
  return store.getBatchDeployment(batchId);
}

export function describeFingerprint(f: BatchFingerprint): string {
  const model =
    f.model_name === f.model_version ? `model ${f.model_version}` : `model ${f.model_name} (reported: ${f.model_version})`;
  const where = f.provider ? `${f.provider}${f.endpoint ? ` @ ${f.endpoint}` : ""} ` : "";
  return `${shortHash(f.hash)} ${where}${model}${f.synthetic ? " [SYNTHETIC: scripted stand-in, not a model]" : ""}`;
}

/** One line per fingerprint, for text reports. */
export function fingerprintLines(s: BatchFingerprintSummary): string[] {
  const lines = s.fingerprints.map((f) => `${describeFingerprint(f)}, ${f.runs} run(s)`);
  if (s.formula_only) {
    lines.push(
      `(same deployment: these hashes differ only because they were computed with fingerprint formulas v${s.formula_versions.join(" and v")}; ` +
        `every component both recorded is equal, so this is not a mid-batch deployment change)`
    );
  }
  if (s.runs_without_fingerprint > 0) {
    lines.push(`(none), ${s.runs_without_fingerprint} run(s): no model response recorded, or the run predates fingerprinting`);
  }
  return lines;
}

/** The warning for a batch whose runs span more than one deployment; null when they do not. */
export function mixedFingerprintWarning(batchId: string, s: BatchFingerprintSummary): string | null {
  if (!s.mixed) return null;
  return (
    `batch ${batchId} spans ${s.fingerprints.length} deployment fingerprints ` +
    `(${s.fingerprints.map((f) => `${shortHash(f.hash)}: ${f.runs} run(s)`).join(", ")}; ` +
    `they differ in ${s.changed.join(", ") || "an unknown component"}). The deployment changed mid-batch, ` +
    `so its consistency scores partly measure that change rather than the agent.`
  );
}
