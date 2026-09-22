import type { AxisGate, AxisName, GateVerdict } from "@invariant/scoring";
import type { BatchDeployment, RunStatus } from "@invariant/trace-store";

export const AXIS_LABEL: Record<AxisName, string> = {
  state_mutation: "state-mutation",
  tool_path: "tool-path",
  outcome: "outcome",
};

export const short = (hash: string | null | undefined, n = 12) => (hash ? hash.slice(0, n) : "none");

export function fmtScore(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : v.toFixed(3);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

const VERDICT: Record<GateVerdict, { cls: string; glyph: string; text: string }> = {
  pass: { cls: "s-pass", glyph: "✓", text: "PASS" },
  pass_with_waivers: { cls: "s-warn", glyph: "✓", text: "PASS WITH WAIVERS" },
  fail: { cls: "s-fail", glyph: "✕", text: "FAIL" },
  incomplete: { cls: "s-warn", glyph: "◐", text: "INCOMPLETE" },
};

export function VerdictBadge({ verdict }: { verdict: GateVerdict | null }) {
  if (!verdict) return <span className="status s-na"><span className="g">○</span>NO VERDICT</span>;
  const v = VERDICT[verdict];
  return (
    <span className={`status ${v.cls}`}>
      <span className="g" aria-hidden>{v.glyph}</span>
      {v.text}
    </span>
  );
}

const RUN_STATUS: Record<RunStatus, { cls: string; glyph: string; text: string }> = {
  ok: { cls: "s-pass", glyph: "●", text: "ok" },
  timeout: { cls: "s-warn", glyph: "◷", text: "timeout" },
  infra_error: { cls: "s-na", glyph: "⚠", text: "infra_error" },
  running: { cls: "s-na", glyph: "…", text: "running" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <span className={`status ${s.cls}`}>
      <span className="g" aria-hidden>{s.glyph}</span>
      {s.text}
    </span>
  );
}

const RESULT_TEXT: Record<AxisGate["result"], string> = {
  pass: "✓ pass",
  fail: "✕ FAIL",
  not_computed: "○ NOT COMPUTED",
  waived: "○ waived",
};

/** Score, a bar with the threshold tick, and the result in words. */
export function AxisCell({ gate }: { gate: AxisGate }) {
  const pct = gate.score === null ? 0 : Math.max(0, Math.min(1, gate.score)) * 100;
  return (
    <div className={`axis ${gate.result}`} title={gate.reason ?? `${fmtScore(gate.score)} vs threshold ${gate.threshold}`}>
      <span className="v">{fmtScore(gate.score)}</span>
      <span className="bar" aria-hidden>
        {gate.score !== null && <span className="fill" style={{ width: `${pct}%` }} />}
        <span className="tick" style={{ left: `calc(${gate.threshold * 100}% - 1px)` }} />
      </span>
      <span className="meta">
        <b>{RESULT_TEXT[gate.result]}</b> · ≥ {gate.threshold.toFixed(2)}
      </span>
    </div>
  );
}

export function SyntheticTag() {
  return <span className="tag tag-synthetic" title="Driven by a scripted stand-in, not a model">SYNTHETIC</span>;
}

export function FpChip({ hash, synthetic }: { hash: string | null; synthetic?: boolean }) {
  if (!hash) return <span className="muted small" title="No model response recorded, or the run predates fingerprinting">no fingerprint</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <a className="fp" href={`/fingerprints?a=${hash}`} title={hash}>
        {short(hash)}
      </a>
      {synthetic && <SyntheticTag />}
    </span>
  );
}

/** Every fingerprint of a batch, with a warning when there is more than one. */
export function Deployment({ d, compact }: { d: BatchDeployment; compact?: boolean }) {
  return (
    <div className="fp-list">
      {d.fingerprints.map((f) => (
        <div key={f.hash} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <FpChip hash={f.hash} synthetic={f.synthetic} />
          {!compact && <span className="mono small ink2">{f.model_version}</span>}
          {d.fingerprints.length > 1 && <span className="small muted">{f.runs} run{f.runs === 1 ? "" : "s"}</span>}
        </div>
      ))}
      {d.fingerprints.length === 0 && d.runs_without_fingerprint > 0 && (
        <span className="small muted">no fingerprints ({d.runs_without_fingerprint} runs predate fingerprinting or got no model response)</span>
      )}
      {d.fingerprints.length > 0 && d.runs_without_fingerprint > 0 && (
        <span className="small muted">+ {d.runs_without_fingerprint} run{d.runs_without_fingerprint === 1 ? "" : "s"} without one</span>
      )}
      {d.mixed && (
        <span className="tag tag-warn" title="The deployment changed during this batch; its scores partly measure that change">
          ⚠ MIXED: {d.changed.join(", ").replace(/_/g, " ")} changed mid-batch
        </span>
      )}
    </div>
  );
}

export function GroupLetter({ letter, index }: { letter: string; index: number }) {
  return <span className={`gl gl-${index % 8}`}>{letter}</span>;
}

export const letterIndex = (l: string) => (l.length === 1 ? l.charCodeAt(0) - 65 : Number(l.slice(1)) - 1);

/** JSON with masked values highlighted. */
export function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const parts = text.split(/("<masked>")/g);
  return (
    <pre className="json">
      {parts.map((p, i) =>
        p === '"<masked>"' ? (
          <span key={i} className="masked" title="volatile field: masked before comparison">
            {p}
          </span>
        ) : (
          p
        )
      )}
    </pre>
  );
}
