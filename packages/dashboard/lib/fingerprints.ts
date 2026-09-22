import { canonicalJson, compareDeployments, type FingerprintComponent, type FingerprintRow, type TraceStore } from "@invariant/trace-store";
import { align, type AlignOp } from "./align";

export interface ToolChange {
  name: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  before: unknown | null;
  after: unknown | null;
}

export interface LineDiff {
  op: AlignOp;
  before: string | null;
  after: string | null;
}

export interface FingerprintComparison {
  a: FingerprintRow;
  b: FingerprintRow;
  changed: FingerprintComponent[];
  /** Components one side did not record (provider/endpoint of a v1 fingerprint). */
  unrecorded: FingerprintComponent[];
  /** Different hashes only because the fingerprint formula changed: the same deployment. */
  formula_only: boolean;
  prompt_diff: LineDiff[] | null;
  tools: ToolChange[];
  /** Same tools with the same schemas, listed in a different order. */
  reordered: boolean;
}

function tools(fp: FingerprintRow): Array<{ name: string; value: unknown }> {
  try {
    return (JSON.parse(fp.tool_schema_json) as Array<Record<string, unknown>>).map((t) => ({ name: String(t.name), value: t }));
  } catch {
    return [];
  }
}

/** Split a prompt into sentences-per-line so a one-sentence edit is one changed row. */
export function promptLines(text: string): string[] {
  return text.split(/\n|(?<=[.!?])\s+/).filter((l) => l.length > 0);
}

export function compareFingerprints(store: TraceStore, aHash: string, bHash: string): FingerprintComparison | null {
  const a = store.getDeploymentFingerprint(aHash);
  const b = store.getDeploymentFingerprint(bHash);
  if (!a || !b) return null;
  const cmp = compareDeployments(a, b);
  const changed = cmp.changed;
  let prompt_diff: LineDiff[] | null = null;
  if (changed.includes("system_prompt")) {
    const la = promptLines(a.system_prompt ?? "");
    const lb = promptLines(b.system_prompt ?? "");
    prompt_diff = align(la, lb).map((s) => ({ op: s.op, before: s.i === null ? null : la[s.i]!, after: s.j === null ? null : lb[s.j]! }));
  }
  const ta = tools(a);
  const tb = tools(b);
  const names = [...new Set([...ta.map((t) => t.name), ...tb.map((t) => t.name)])];
  const toolChanges: ToolChange[] = names.map((name) => {
    const before = ta.find((t) => t.name === name)?.value ?? null;
    const after = tb.find((t) => t.name === name)?.value ?? null;
    const kind = before === null ? "added" : after === null ? "removed" : canonicalJson(before) === canonicalJson(after) ? "unchanged" : "changed";
    return { name, kind, before, after };
  });
  const reordered =
    changed.includes("tool_schema") &&
    toolChanges.every((t) => t.kind === "unchanged") &&
    ta.map((t) => t.name).join() !== tb.map((t) => t.name).join();
  return { a, b, changed, unrecorded: cmp.unrecorded, formula_only: cmp.formula_only, prompt_diff, tools: toolChanges, reordered };
}
