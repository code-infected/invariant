import { buildLeaderboard, type LeaderRow } from "../lib/leaderboard";
import { storeRoot, tasksDir } from "../lib/env";
import { loadSpecs } from "../lib/specs";
import { withStore } from "../lib/store";
import { AxisCell, Deployment, fmtTime, short, VerdictBadge } from "../components/ui";
import { StoreProblem } from "../components/store-problem";

export const dynamic = "force-dynamic";

function Runs({ row }: { row: LeaderRow }) {
  if (!row.batch) return <span className="muted">–</span>;
  const other = Object.entries(row.status_counts).filter(([s]) => s !== "ok");
  return (
    <div className="num">
      <span className="mono">
        {row.runs_scored ?? "–"} / {row.runs_total}
      </span>
      {other.length > 0 && (
        <div className="small muted">
          {other.map(([s, n]) => `${n} ${s}`).join(", ")}
        </div>
      )}
    </div>
  );
}

const STATE_TEXT: Record<LeaderRow["state"], string> = {
  scored: "",
  unscored: "latest batch not scored yet: run invariant score",
  no_finished_batch: "no finished batch",
  no_batch: "never run in this store",
  not_runnable: "not runnable",
  spec_error: "task spec does not parse",
};

export default function Leaderboard() {
  const specs = loadSpecs(tasksDir());
  return withStore(storeRoot(), (state) => {
    if (state.kind !== "ok" && state.kind !== "missing") return <StoreProblem state={state} />;
    const { rows, served } = buildLeaderboard(state.kind === "ok" ? state.store : null, specs);
    return (
      <>
        <div className="page-head">
          <h1>Consistency leaderboard</h1>
          <span className="muted">{rows.length} task{rows.length === 1 ? "" : "s"}</span>
        </div>
        <p className="lede">
          Latest finished batch per task, most at-risk first. Verdicts apply the gate&apos;s rule to the latest stored
          score (no rescoring, no waivers): an axis without a score fails closed as <b>incomplete</b>. The bar tick marks
          the threshold. Thresholds come from <code>tasks/&lt;name&gt;.yaml</code> as it is now, like the CI gate (a row says
          so when it falls back to the copy stored with the task&apos;s last run).
        </p>
        {state.kind === "missing" && (
          <div className="note neutral">
            No trace store at <code>{state.root}</code> yet. Tasks below are read from <code>tasks/</code>; nothing has been
            run. Run a tier (<code>invariant run --tier=smoke</code>) or seed a demo store (
            <code>invariant demo-seed --store=.invariant-demo</code>).
          </div>
        )}
        {rows.length === 0 ? (
          <div className="panel empty">No tasks in the store and no task specs under tasks/.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>Task</th>
                  <th>Verdict</th>
                  <th>State-mutation</th>
                  <th>Tool-path</th>
                  <th>Outcome</th>
                  <th className="r">Scored / runs</th>
                  <th>Latest batch</th>
                  <th>Deployment fingerprint</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.task}>
                    <td className="r muted num">{i + 1}</td>
                    <td>
                      {row.batch ? (
                        <a className="mono nowrap" href={`/tasks/${encodeURIComponent(row.task)}`}>
                          {row.task}
                        </a>
                      ) : (
                        <span className="mono nowrap">{row.task}</span>
                      )}
                      {row.thresholds_source && !row.thresholds_source.startsWith("tasks/") && (
                        <div className="small muted">thresholds: {row.thresholds_source}</div>
                      )}
                    </td>
                    {row.state === "scored" && row.axes ? (
                      <>
                        <td>
                          <VerdictBadge verdict={row.verdict} />
                        </td>
                        {row.axes.map((a) => (
                          <td key={a.axis}>
                            <AxisCell gate={a} />
                          </td>
                        ))}
                      </>
                    ) : (
                      <>
                        <td>
                          <span className={`status ${row.state === "not_runnable" || row.state === "spec_error" ? "s-na" : "s-warn"}`}>
                            <span className="g">○</span>
                            {row.state === "not_runnable" ? "NOT RUNNABLE" : row.state === "spec_error" ? "SPEC ERROR" : "NOT MEASURED"}
                          </span>
                        </td>
                        <td colSpan={3} className="small ink2">
                          {STATE_TEXT[row.state]}
                          {row.state === "not_runnable" && served && (
                            <>
                              : the tool server recorded in fingerprint <span className="fp">{short(served.fingerprint)}</span> serves{" "}
                              <span className="mono">[{served.tools.join(", ")}]</span>, not{" "}
                              <span className="mono">[{row.missing_tools.join(", ")}]</span>. No consistency has been measured.
                            </>
                          )}
                          {row.state === "no_batch" && !served && " (runnability unknown: no tool list has been recorded in a fingerprint yet)"}
                          {row.note && <div className="muted">{row.note}</div>}
                          {row.unfinished_newer && (
                            <div className="muted">batch {short(row.unfinished_newer.id, 8)} started {fmtTime(row.unfinished_newer.created_at)} has not finished</div>
                          )}
                        </td>
                      </>
                    )}
                    <td className="r">
                      <Runs row={row} />
                    </td>
                    <td>
                      {row.batch ? (
                        <>
                          <a className="mono" href={`/batches/${row.batch.id}`}>
                            {short(row.batch.id, 8)}
                          </a>{" "}
                          <span className="small muted">{row.batch.tier}</span>
                          <div className="small muted num nowrap">{fmtTime(row.batch.created_at)}</div>
                          {row.unfinished_newer && <div className="small tag tag-warn">newer batch unfinished</div>}
                        </>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                    <td>{row.deployment ? <Deployment d={row.deployment} compact /> : <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  });
}
