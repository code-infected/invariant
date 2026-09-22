import { notFound, redirect } from "next/navigation";
import { getBatchDetail, memberSummary, type MatrixCell } from "../../../lib/batch";
import { storeRoot, tasksDir } from "../../../lib/env";
import { loadSpecs } from "../../../lib/specs";
import { withStore } from "../../../lib/store";
import { StoreProblem } from "../../../components/store-problem";
import {
  AxisCell,
  Deployment,
  fmtTime,
  GroupLetter,
  letterIndex,
  RunStatusBadge,
  short,
  SyntheticTag,
  VerdictBadge,
} from "../../../components/ui";

export const dynamic = "force-dynamic";

const KIND_SHORT = { mutation: "M", path: "P", outcome: "O" } as const;

function Cell({ cell, reference, showSynthetic, showFp }: { cell: MatrixCell; reference: string | null; showSynthetic: boolean; showFp: boolean }) {
  if (!cell.run) return <td className="cell muted small">no run</td>;
  const isRef = cell.run.id === reference;
  const href = reference && !isRef ? `/diff?a=${reference}&b=${cell.run.id}` : `/diff?a=${cell.run.id}`;
  return (
    <td className={`cell${isRef ? " ref" : ""}`}>
      <a href={href} title={isRef ? "reference run (largest mutation group)" : "compare with the reference run"}>
        <div className="cell-top">
          <RunStatusBadge status={cell.run.status} />
          {cell.superseded.length > 0 && (
            <span className="tag" title={`${cell.superseded.length} earlier attempt(s) failed with an infra error and were retried`}>
              +{cell.superseded.length} retried
            </span>
          )}
          {showSynthetic && cell.synthetic && <SyntheticTag />}
          {showFp && (
            <span className="fp" title={cell.run.deployment_fingerprint ?? "no fingerprint"}>
              {cell.run.deployment_fingerprint ? short(cell.run.deployment_fingerprint, 8) : "no fp"}
            </span>
          )}
        </div>
        <div className="cell-groups">
          {(["mutation", "path", "outcome"] as const).map((k) =>
            cell.groups[k] ? (
              <span key={k} title={`${k} group ${cell.groups[k]}`}>
                {KIND_SHORT[k]} <GroupLetter letter={cell.groups[k]!} index={letterIndex(cell.groups[k]!)} />
              </span>
            ) : (
              <span key={k} title={`${k}: not grouped (excluded or not scored)`}>
                {KIND_SHORT[k]} <span className="muted">–</span>
              </span>
            )
          )}
        </div>
        <div className="cell-path">{cell.path.length ? cell.path.join(" › ") : "(no tool calls)"}</div>
        {isRef && <div className="small" style={{ color: "var(--link)" }}>reference</div>}
      </a>
    </td>
  );
}

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const specs = loadSpecs(tasksDir());
  return withStore(storeRoot(), (state) => {
    if (state.kind !== "ok") return <StoreProblem state={state} />;
    // Adversarial batches have their own view; they are never shown as a consistency matrix.
    if (state.store.getBatch(id)?.kind === "adversarial") redirect(`/adversarial/${id}`);
    const d = getBatchDetail(state.store, id, specs);
    if (!d) notFound();
    const runIds = d.cells.flat().filter((c) => c.run).map((c) => c.run!);
    const withRuns = d.cells.flat().filter((c) => c.run);
    // Runs with no fingerprint (no model answered) cannot be labelled either way; judge by the rest.
    const fingerprinted = withRuns.filter((c) => c.run!.deployment_fingerprint !== null);
    const allSynthetic = fingerprinted.length > 0 && fingerprinted.every((c) => c.synthetic);
    const someSynthetic = withRuns.some((c) => c.synthetic);
    return (
      <>
        <div className="crumbs">
          <a href="/">Leaderboard</a> / <a href={`/tasks/${encodeURIComponent(d.task.name)}`}>{d.task.name}</a> / batch
        </div>
        <div className="page-head">
          <h1 className="mono">{d.batch.id}</h1>
          <VerdictBadge verdict={d.verdict} />
          {someSynthetic && <SyntheticTag />}
          {d.deployment.mixed && <span className="tag tag-warn">⚠ MIXED DEPLOYMENT</span>}
        </div>
        <p className="lede">
          {d.batch.tier} tier · [{d.variants.join(", ")}] × {d.trials.length} trial{d.trials.length === 1 ? "" : "s"} ·{" "}
          {d.score ? `${d.score.runs_scored} of ${d.runs_total} runs scored` : `${d.runs_total} runs, not scored`} · started{" "}
          {fmtTime(d.batch.created_at)} · finished {fmtTime(d.batch.finished_at)}
        </p>

        <div className="grid2">
          <div className="panel panel-pad">
            <h2>Axes</h2>
            {d.axes ? (
              <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                {d.axes.map((a) => (
                  <div key={a.axis}>
                    <div className="small ink2" style={{ marginBottom: 3 }}>{a.axis.replace("_", "-")}</div>
                    <AxisCell gate={a} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="note">Not scored yet. Run <code>invariant score --batch={d.batch.id}</code>.</div>
            )}
            {d.axes?.some((a) => a.result === "not_computed") && (
              <div className="note">
                {d.axes.filter((a) => a.result === "not_computed").map((a) => `${a.axis.replace("_", "-")}: ${a.reason}`).join(" ")}
              </div>
            )}
            {d.thresholds_source && <div className="small muted">thresholds from {d.thresholds_source}; score {short(d.score?.id, 8)} computed {fmtTime(d.score?.computed_at)}</div>}
          </div>
          <div className="panel panel-pad">
            <h2>Deployment</h2>
            <Deployment d={d.deployment} />
            {d.deployment.mixed && (
              <p className="small ink2" style={{ marginTop: 8 }}>
                The deployment changed during this batch, so its consistency scores partly measure that change rather than the
                agent. <a href={`/fingerprints?a=${d.deployment.fingerprints[0]!.hash}&b=${d.deployment.fingerprints[1]!.hash}`}>What changed →</a>
              </p>
            )}
          </div>
        </div>

        <div className="section">
          <h2>Run matrix</h2>
          <p className="small ink2">
            Each cell: status, then its group in each grouping below (<b>M</b> mutation signature, <b>P</b> tool path, <b>O</b>{" "}
            outcome), then its tool path.{d.deployment.mixed && " In this mixed batch each cell also shows its fingerprint."}
            {allSynthetic && " Every run here is SYNTHETIC (scripted stand-in)."} Click a cell to diff it against the reference run.
          </p>
          <div className="table-wrap">
            <table className="data matrix">
              <thead>
                <tr>
                  <th>Variant</th>
                  {d.trials.map((t) => (
                    <th key={t}>Trial {t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.cells.map((row, vi) => (
                  <tr key={d.variants[vi]}>
                    <td className="mono">{d.variants[vi]}</td>
                    {row.map((c) => (
                      <Cell key={c.trial} cell={c} reference={d.reference_run} showSynthetic={!allSynthetic} showFp={d.deployment.mixed} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.excluded.length > 0 && (
            <p className="small ink2" style={{ marginTop: 6 }}>
              {d.excluded.length} run{d.excluded.length === 1 ? "" : "s"} without a behavioural answer ({d.excluded.map((e) => e.status).join(", ")}) excluded from every axis.
            </p>
          )}
        </div>

        <div className="section grid3">
          {d.groupings.map((g) => (
            <div className="panel panel-pad" key={g.kind}>
              <h2>
                {KIND_SHORT[g.kind]} · {g.title}
              </h2>
              <div className="small muted" style={{ marginBottom: 6 }}>{g.source}</div>
              {g.note && <div className="note">{g.note}</div>}
              {g.groups.map((grp, i) => (
                <div className="group-row" key={grp.letter}>
                  <GroupLetter letter={grp.letter} index={i} />
                  <span className="mono num">{grp.members.length}×</span>
                  <div>
                    <div className="group-label">{grp.label}</div>
                    <div className="group-members">{memberSummary(grp.members)}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="section">
          <h2>Compare two runs</h2>
          <form className="inline" action="/diff" method="get">
            {(["a", "b"] as const).map((side, si) => (
              <select name={side} key={side} defaultValue={si === 0 ? (d.reference_run ?? "") : (runIds.find((r) => r.id !== d.reference_run)?.id ?? "")}>
                {d.cells.flat().filter((c) => c.run).map((c) => (
                  <option key={c.run!.id} value={c.run!.id}>
                    {c.variant} trial {c.trial} · {c.run!.status} · M{c.groups.mutation ?? "–"} P{c.groups.path ?? "–"}
                  </option>
                ))}
              </select>
            ))}
            <button type="submit">Diff</button>
          </form>
        </div>
      </>
    );
  });
}
