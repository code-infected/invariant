import { diffRuns, runSide, type CallView, type DiffRow, type RunSide, type TraceDiff } from "../../lib/diff";
import { storeRoot } from "../../lib/env";
import { withStore } from "../../lib/store";
import { StoreProblem } from "../../components/store-problem";
import { FpChip, fmtTime, Json, RunStatusBadge, short, SyntheticTag } from "../../components/ui";
import type { TraceStore } from "@invariant/trace-store";

export const dynamic = "force-dynamic";

function Side({ s, label }: { s: RunSide; label: string }) {
  return (
    <div className="panel panel-pad">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>
          {label} · <span className="mono">{s.variant}</span> trial {s.run.trial_number}
        </h3>
        <RunStatusBadge status={s.run.status} />
        {s.synthetic && <SyntheticTag />}
      </div>
      <dl className="kv">
        <dt>run</dt>
        <dd className="mono">{s.run.id}</dd>
        <dt>task</dt>
        <dd className="mono">{s.task_name}</dd>
        <dt>batch</dt>
        <dd>{s.batch_id ? <a className="mono" href={`/batches/${s.batch_id}`}>{short(s.batch_id, 8)}</a> : <span className="muted">single debugging run</span>} <span className="muted">attempt {s.run.attempt}</span></dd>
        <dt>fingerprint</dt>
        <dd>
          <FpChip hash={s.fingerprint} /> {s.model_version && <span className="mono small ink2">{s.model_version}</span>}
        </dd>
        <dt>prompt</dt>
        <dd className="ink2">{s.prompt}</dd>
        <dt>final output</dt>
        <dd>{s.run.final_output ?? <span className="muted">(none)</span>}</dd>
        <dt>latency</dt>
        <dd className="num">{s.run.latency_ms ?? "–"} ms · {s.calls.length} tool call{s.calls.length === 1 ? "" : "s"}</dd>
      </dl>
    </div>
  );
}

function Call({ c }: { c: CallView | null }) {
  if (!c) return <div className="empty-side">no call at this step</div>;
  return (
    <div className={`call${c.is_sandboxed ? " sandboxed" : ""}`}>
      <div className="call-head">
        <span className="muted mono small">#{c.sequence_index}</span>
        <span className="call-name">{c.tool_name}</span>
        {c.is_sandboxed && (
          <span className="tag tag-sandbox" title="Dangerous tool: intercepted by the proxy, synthetic response, never reached the backend">
            ⛨ SANDBOXED
          </span>
        )}
        <span className="muted small num">{fmtTime(c.timestamp).slice(11)}</span>
      </div>
      <div className="small muted">args{c.masked_fields.length ? ` (volatile, masked: ${c.masked_fields.join(", ")})` : ""}</div>
      <Json value={c.args_masked} />
      {c.masked_fields.length > 0 && (
        <details>
          <summary>raw args (unmasked)</summary>
          <Json value={c.args_raw} />
        </details>
      )}
      <details>
        <summary>response{c.is_sandboxed ? " (sandbox response from the task spec)" : ""}</summary>
        <Json value={c.response} />
      </details>
    </div>
  );
}

const OP_TEXT: Record<DiffRow["op"], string> = { match: "=", substitute: "≠ tool", insert: "+ right", delete: "− left" };

function Summary({ d }: { d: TraceDiff }) {
  if (d.first_divergence === null) {
    return (
      <div className="divergence none">
        ✓ No divergence: same tool path and identical arguments after masking [{d.volatile_fields.join(", ")}]. Path similarity{" "}
        {d.path_similarity.toFixed(3)}.
      </div>
    );
  }
  const row = d.rows[d.first_divergence]!;
  const what =
    d.divergence_kind === "tool"
      ? row.op === "substitute"
        ? `left calls ${row.left!.tool_name}, right calls ${row.right!.tool_name}`
        : row.op === "insert"
          ? `only right calls ${row.right!.tool_name}`
          : `only left calls ${row.left!.tool_name}`
      : `both call ${row.left!.tool_name}, with different arguments (after masking)`;
  return (
    <div className="divergence found">
      ✕ First divergence at aligned step {d.first_divergence + 1}: {what}. Tool-path similarity {d.path_similarity.toFixed(3)} (
      {d.rows.filter((r) => r.op !== "match").length} edit{d.rows.filter((r) => r.op !== "match").length === 1 ? "" : "s"}).
    </div>
  );
}

interface PickerOption {
  id: string;
  label: string;
}

/** Runs of run a's batch, resolved while the store is open (components render after it closes). */
function pickerOptions(store: TraceStore, a: string): PickerOption[] {
  const side = runSide(store, a);
  if (!side?.batch_id) return [];
  return store.getBatchRuns(side.batch_id).map((r) => ({
    id: r.id,
    label: `${store.getVariant(r.variant_id)?.label} trial ${r.trial_number} · ${r.status}`,
  }));
}

function Picker({ options, a, b }: { options: PickerOption[]; a?: string; b?: string }) {
  if (options.length === 0) return null;
  return (
    <form className="inline" action="/diff" method="get" style={{ margin: "8px 0 4px" }}>
      <span className="small muted">compare</span>
      {(["a", "b"] as const).map((k) => (
        <select key={k} name={k} defaultValue={(k === "a" ? a : b) ?? ""}>
          {k === "b" && <option value="">(none)</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ))}
      <button type="submit">Diff</button>
    </form>
  );
}

export default async function DiffPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  return withStore(storeRoot(), (state) => {
    if (state.kind !== "ok") return <StoreProblem state={state} />;
    const head = (
      <>
        <div className="page-head">
          <h1>Trace diff</h1>
        </div>
        <p className="lede">
          Two runs&apos; tool-call sequences aligned with the tool-path axis&apos;s edit model (Levenshtein over tool names), so
          an inserted or swapped step lines up instead of shifting everything after it. Arguments are compared after masking
          the task&apos;s volatile fields; raw values stay one click away.
        </p>
      </>
    );
    if (!a) {
      return (
        <>
          {head}
          <div className="panel empty">Pick two runs from a batch&apos;s run matrix (click a cell), or pass <code>?a=RUN_ID&amp;b=RUN_ID</code>.</div>
        </>
      );
    }
    const single = !b || b === a;
    const d = single ? null : diffRuns(state.store, a, b!);
    const sa = single ? runSide(state.store, a) : d?.a;
    if (!sa || (!single && !d)) {
      return (
        <>
          {head}
          <div className="panel empty">No run with id <code>{!sa ? a : b}</code> in this store.</div>
        </>
      );
    }
    const rows: DiffRow[] = d ? d.rows : sa.calls.map((c) => ({ op: "match", left: c, right: null, args_equal: null }));
    return (
      <>
        {head}
        <Picker options={pickerOptions(state.store, a)} a={a} b={single ? undefined : b} />
        <div className="grid2">
          <Side s={sa} label="Left" />
          {d ? <Side s={d.b} label="Right" /> : <div className="panel panel-pad muted">Single run. Pick a second run above to diff.</div>}
        </div>
        {d && !d.same_task && <div className="note">These runs belong to different tasks; masking uses both tasks&apos; volatile fields.</div>}
        {d && <Summary d={d} />}
        <div className="table-wrap" style={{ marginTop: d ? 0 : 12 }}>
          <table className="data diff">
            <colgroup>
              <col className="step" />
              <col />
              {d && <col style={{ width: 88 }} />}
              {d && <col />}
            </colgroup>
            <thead>
              <tr>
                <th className="r">Step</th>
                <th>Left</th>
                {d && <th style={{ textAlign: "center" }}>Diff</th>}
                {d && <th>Right</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cls = [
                  `row-${r.op}`,
                  r.args_equal === false ? "row-args" : "",
                  d && d.first_divergence === i ? "first-div" : "",
                ].join(" ");
                return (
                  <tr key={i} className={cls}>
                    <td className="r mono muted">
                      {i + 1}
                      {d && d.first_divergence === i && <div className="small" style={{ color: "var(--fail)", fontWeight: 700 }}>FIRST</div>}
                    </td>
                    <td>
                      <Call c={r.left} />
                    </td>
                    {d && (
                      <td className="op">
                        {r.op === "match" ? (r.args_equal === false ? "≠ args" : "=") : OP_TEXT[r.op]}
                      </td>
                    )}
                    {d && (
                      <td>
                        <Call c={r.right} />
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No tool calls in {d ? "either run" : "this run"}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  });
}
