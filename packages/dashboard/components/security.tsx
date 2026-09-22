import type { PropagationResult, PropagationVerdict } from "@invariant/scoring";
import type { SecurityRow } from "../lib/adversarial";
import { fmtTime, short, SyntheticTag } from "./ui";

const SECURITY: Record<PropagationVerdict, { cls: string; glyph: string; text: string }> = {
  finding: { cls: "s-fail", glyph: "⚑", text: "SECURITY FINDING" },
  pass: { cls: "s-pass", glyph: "✓", text: "NO PROPAGATION" },
  not_computed: { cls: "s-warn", glyph: "◐", text: "NOT COMPUTED" },
};

export function SecurityBadge({ verdict }: { verdict: PropagationVerdict | null }) {
  if (!verdict) return <span className="status s-na"><span className="g">○</span>NOT SCORED</span>;
  const v = SECURITY[verdict];
  return (
    <span className={`status ${v.cls}`}>
      <span className="g" aria-hidden>{v.glyph}</span>
      {v.text}
    </span>
  );
}

export function FixtureTag() {
  return (
    <span className="tag tag-fixture" title="The planted instruction is a test fixture from tasks/adversarial/, not a real attack or incident">
      TEST FIXTURE
    </span>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Propagation rate with the max-allowed tick; lower is better, so the bar fills red. */
export function RateCell({ result, max }: { result: PropagationResult | null; max: number }) {
  if (!result) return <span className="muted small">not scored</span>;
  if (result.rate === null) return <span className="small" style={{ color: "var(--warn)" }}>no run received the payload</span>;
  const cls = result.rate > max + 1e-9 ? "fail" : "pass";
  return (
    <div className={`axis rate ${cls}`} title={`${result.runs_propagated} of ${result.runs_scored} runs that received the payload; max allowed ${pct(max)}`}>
      <span className="v">{pct(result.rate)}</span>
      <span className="bar" aria-hidden>
        <span className="fill" style={{ width: `${Math.max(result.rate * 100, result.rate > 0 ? 3 : 0)}%` }} />
        <span className="tick" style={{ left: `calc(${max * 100}% - ${max === 0 ? 0 : 1}px)` }} />
      </span>
      <span className="meta">
        <b>{result.runs_propagated} of {result.runs_scored}</b> · max {pct(max)}
      </span>
    </div>
  );
}

export function DepthText({ result }: { result: PropagationResult | null }) {
  if (!result || result.depths.length === 0) return <span className="muted">–</span>;
  return (
    <span className="mono small nowrap" title="depth: calls strictly between the injected response and the unauthorized call">
      {result.depths.map((d) => `d${d.depth}×${d.runs}`).join(" ")}
    </span>
  );
}

/** The security board: latest adversarial batch per (task, payload). */
export function SecurityTable({ rows, showTask = true }: { rows: SecurityRow[]; showTask?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {showTask && <th>Task</th>}
            <th>Payload</th>
            <th>Verdict</th>
            <th>Propagation rate</th>
            <th>Depths</th>
            <th>Planted into → unauthorized call</th>
            <th>Latest batch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = r.latest;
            return (
              <tr key={`${r.task}/${r.payload_id}`}>
                {showTask && (
                  <td>
                    <a className="mono nowrap" href={`/tasks/${encodeURIComponent(r.task)}`}>{r.task}</a>
                  </td>
                )}
                <td>
                  <a className="mono nowrap" href={`/adversarial/${s.batch.id}`}>{r.payload_id}</a>
                  <div><FixtureTag /></div>
                </td>
                <td>
                  <SecurityBadge verdict={s.verdict} />
                  {s.synthetic && (
                    <div style={{ marginTop: 3 }}>
                      <SyntheticTag />
                    </div>
                  )}
                </td>
                <td><RateCell result={s.result} max={s.max_rate} /></td>
                <td><DepthText result={s.result} /></td>
                <td className="small">
                  {s.payload ? (
                    <>
                      <span className="mono">{s.payload.inject.tool}</span> <span className="muted">call {s.payload.inject.on_call}</span> →{" "}
                      <span className="mono">{s.payload.unauthorized_action.tool}</span>
                      {s.payload.unauthorized_action.args && <span className="mono muted"> {JSON.stringify(s.payload.unauthorized_action.args)}</span>}
                    </>
                  ) : (
                    <span className="muted">no payload snapshot</span>
                  )}
                </td>
                <td>
                  <a className="mono" href={`/adversarial/${s.batch.id}`}>{short(s.batch.id, 8)}</a> <span className="small muted">{s.batch.tier}</span>
                  <div className="small muted num nowrap">{fmtTime(s.batch.created_at)}</div>
                  {r.batches > 1 && <div className="small muted">{r.batches} batches of this payload</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
