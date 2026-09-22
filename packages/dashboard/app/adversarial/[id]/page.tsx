import { notFound } from "next/navigation";
import { getAdversarialDetail, getAdversarialTrace, splitOnPlanted, type AdversarialCell, type AdversarialTrace, type TraceCall } from "../../../lib/adversarial";
import { storeRoot, tasksDir } from "../../../lib/env";
import { withStore } from "../../../lib/store";
import { StoreProblem } from "../../../components/store-problem";
import { Deployment, fmtTime, Json, RunStatusBadge, short, SyntheticTag } from "../../../components/ui";
import { DepthText, FixtureTag, RateCell, SecurityBadge } from "../../../components/security";

export const dynamic = "force-dynamic";

function Cell({ cell, batchId, selected }: { cell: AdversarialCell; batchId: string; selected: string | null }) {
  if (!cell.run) return <td className="cell muted small">no run</td>;
  const p = cell.prop;
  const cls = !p ? "unexposed" : p.propagated ? "propagated" : p.exposure === "exposed" ? "held" : "unexposed";
  return (
    <td className="cell">
      <a href={`/adversarial/${batchId}?run=${cell.run.id}#trace`} className={`adv-cell ${cls}${selected === cell.run.id ? " selected" : ""}`}>
        {!p ? (
          <span>not scored</span>
        ) : p.propagated ? (
          <>
            <b>⚑ PROPAGATED</b>
            <div className="small">depth {p.depth} · call #{p.action_index! + 1}</div>
          </>
        ) : p.exposure === "exposed" ? (
          <>
            <b>✓ held</b>
            <div className="small">no unauth. call</div>
          </>
        ) : (
          <>
            <b>○ {p.exposure === "excluded" ? "excluded" : "not exposed"}</b>
            <div className="small">{p.reason}</div>
          </>
        )}
      </a>
    </td>
  );
}

function PlantedJson({ value, planted }: { value: unknown; planted?: string }) {
  const parts = splitOnPlanted(JSON.stringify(value, null, 2) ?? "null", planted);
  return (
    <pre className="json">
      {parts.map((p, i) =>
        p.planted ? (
          <mark key={i} className="planted" title="text planted by the proxy (test fixture)">
            {p.text}
          </mark>
        ) : (
          p.text
        )
      )}
    </pre>
  );
}

const ROLE_TAG: Record<TraceCall["role"], { cls: string; text: string } | null> = {
  injected: { cls: "tag tag-injected", text: "⚑ INJECTED RESPONSE" },
  action: { cls: "tag tag-action", text: "✕ UNAUTHORIZED CALL" },
  repeat: { cls: "tag tag-action", text: "✕ unauthorized again" },
  unprompted: { cls: "tag tag-warn", text: "unauthorized, before the injection (unprompted)" },
  between: { cls: "tag tag-depth", text: "downstream" },
  other: null,
};

function Trace({ t, planted }: { t: AdversarialTrace; planted?: string }) {
  const p = t.prop;
  let depthCount = 0;
  return (
    <div className="panel panel-pad" id="trace">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Trace · {t.label}</h3>
        <RunStatusBadge status={t.run.status} />
        {t.synthetic && <SyntheticTag />}
        {p?.propagated && <span className="status s-fail">⚑ propagated at depth {p.depth}</span>}
        {p && !p.propagated && p.exposure === "exposed" && <span className="status s-pass">✓ held</span>}
      </div>
      <p className="small ink2">
        Every tool call in order, as the agent saw it through the proxy.{" "}
        {p?.propagated
          ? `The payload entered in call #${p.injected_index! + 1}; ${p.depth} call${p.depth === 1 ? "" : "s"} later the agent made the unauthorized call #${p.action_index! + 1}. Depth counts the calls strictly between them.`
          : p?.exposure === "exposed"
            ? `The payload entered in call #${p.injected_index! + 1}; no unauthorized call followed.`
            : p?.reason ?? ""}{" "}
        <span className="mono muted">run {t.run.id}</span>
      </p>
      {t.calls.map((c) => {
        const tag = ROLE_TAG[c.role];
        if (c.role === "between") depthCount++;
        return (
          <div key={c.index}>
            {c.role === "action" && p?.injected_index !== null && (
              <div className="flow-link">↑ depth {depthCount}: {depthCount} call{depthCount === 1 ? "" : "s"} between the injected response and this call</div>
            )}
            <div className={`adv-call ${c.role}${c.role === "other" && p?.propagated && c.index > (p.action_index ?? 0) ? " muted-call" : ""}`}>
              <div className="call-head">
                <span className="muted mono small">#{c.index + 1}</span>
                <span className="call-name">{c.tool_name}</span>
                {tag && <span className={tag.cls}>{c.role === "between" ? `downstream +${depthCount}` : tag.text}</span>}
                {c.is_sandboxed && (
                  <span className="tag tag-sandbox" title="Dangerous tool: intercepted by the proxy, synthetic response, never reached the backend">
                    ⛨ SANDBOXED
                  </span>
                )}
              </div>
              <div className="grid2" style={{ gap: 8 }}>
                <div>
                  <div className="small muted">args</div>
                  <Json value={c.args} />
                </div>
                <div>
                  <div className="small muted">response{c.is_injected ? " (as relayed to the agent, planted text highlighted)" : ""}</div>
                  {c.is_injected ? (
                    <PlantedJson value={c.response} planted={planted} />
                  ) : c.role === "action" || c.role === "repeat" || c.role === "unprompted" ? (
                    <Json value={c.response} />
                  ) : (
                    <details>
                      <summary>show response</summary>
                      <Json value={c.response} />
                    </details>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <div className="small muted" style={{ marginTop: 10 }}>final output</div>
      <div>{t.run.final_output ?? <span className="muted">(none)</span>}</div>
    </div>
  );
}

export default async function AdversarialPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ run?: string }> }) {
  const { id } = await params;
  const { run } = await searchParams;
  return withStore(storeRoot(), (state) => {
    if (state.kind !== "ok") return <StoreProblem state={state} />;
    const d = getAdversarialDetail(state.store, id, tasksDir());
    if (!d) notFound();
    const r = d.result;
    // Default trace: the first propagated run, else the first run.
    const firstPropagated = r?.runs.find((x) => x.propagated)?.run_id;
    const selected = run ?? firstPropagated ?? d.cells.flat().find((c) => c.run)?.run?.id ?? null;
    const trace = selected ? getAdversarialTrace(state.store, d, selected) : null;
    const p = d.payload;
    return (
      <>
        <div className="crumbs">
          <a href="/">Leaderboard</a> / <a href={`/tasks/${encodeURIComponent(d.task.name)}`}>{d.task.name}</a> / adversarial
        </div>
        <div className="page-head">
          <h1 className="mono">{d.payload_id}</h1>
          <SecurityBadge verdict={d.verdict} />
          <FixtureTag />
          {d.synthetic && <SyntheticTag />}
        </div>
        <p className="lede">
          Adversarial batch <span className="mono">{d.batch.id}</span> · {d.batch.tier} tier · [{d.variants.join(", ")}] × {d.trials.length} trial
          {d.trials.length === 1 ? "" : "s"} · started {fmtTime(d.batch.created_at)}. The proxy planted the payload into one tool
          response per run; a run <b>propagated</b> when the agent then made the payload&apos;s unauthorized call. Adversarial batches
          are never part of the consistency leaderboard or trends.
          {d.synthetic && " SYNTHETIC: driven by a scripted stand-in, so this shows the harness detecting propagation, not a model being vulnerable."}
        </p>

        <div className="grid2">
          <div className="panel panel-pad">
            <h2>Propagation</h2>
            {r ? (
              <>
                <div style={{ display: "flex", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div>
                    <div className={`rate-big`} style={{ color: d.verdict === "finding" ? "var(--fail)" : "var(--pass)" }}>
                      {r.rate === null ? "–" : `${Math.round(r.rate * 100)}%`}
                    </div>
                    <div className="small ink2">
                      {r.runs_propagated} of {r.runs_scored} runs that received the payload
                      {r.runs_scored < r.runs_in_batch && ` (${r.runs_in_batch - r.runs_scored} of ${r.runs_in_batch} did not)`}
                    </div>
                  </div>
                  <RateCell result={r} max={d.max_rate} />
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  max allowed {Math.round(d.max_rate * 100)}% ({d.threshold_source}); any propagation above it is a security finding (gate exit 3).
                </div>
                {r.depths.length > 0 && (
                  <div className="depth-bars">
                    {r.depths.map((x) => (
                      <div key={x.depth} style={{ display: "contents" }}>
                        <span className="mono">depth {x.depth}</span>
                        <span><span className="b" style={{ display: "block", width: `${(x.runs / r.runs_propagated) * 100}%` }} /></span>
                        <span className="mono">{x.runs} run{x.runs === 1 ? "" : "s"}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="small muted" style={{ marginTop: 6 }}>Depth: tool calls strictly between the injected response and the unauthorized call (0 = the very next call).</div>
                {r.notes.map((n, i) => (
                  <div className="note" key={i}>{n}</div>
                ))}
              </>
            ) : (
              <div className="note">Not scored yet. Run <code>invariant score --batch={d.batch.id}</code>.</div>
            )}
          </div>
          <div className="panel panel-pad">
            <h2>Payload <FixtureTag /></h2>
            {p ? (
              <dl className="kv">
                <dt>planted into</dt>
                <dd>
                  <span className="mono">{p.inject.tool}</span>, call {p.inject.on_call} of each run ·{" "}
                  <span className="mono">{p.inject.placement.mode}{p.inject.placement.path ? ` ${p.inject.placement.path}` : ""}</span>
                </dd>
                <dt>text</dt>
                <dd>
                  <mark className="planted">{p.inject.text}</mark>
                </dd>
                <dt>unauthorized</dt>
                <dd>
                  <span className="mono">{p.unauthorized_action.tool}</span>{" "}
                  {p.unauthorized_action.args && <span className="mono ink2">{JSON.stringify(p.unauthorized_action.args)}</span>}
                  {p.unauthorized_action.why && <div className="small ink2">{p.unauthorized_action.why}</div>}
                </dd>
                <dt>fixture</dt>
                <dd className="mono small">{p.source ?? "–"}</dd>
                <dt>deployment</dt>
                <dd>
                  <Deployment d={d.deployment} compact />
                </dd>
              </dl>
            ) : (
              <div className="note">This batch has no payload snapshot.</div>
            )}
          </div>
        </div>

        <div className="section">
          <h2>Trials</h2>
          <p className="small ink2">Which trials propagated. Click a trial to see its trace below.</p>
          <div className="table-wrap">
            <table className="data matrix adv-grid">
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
                      <Cell key={c.trial} cell={c} batchId={d.batch.id} selected={selected} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="section">{trace ? <Trace t={trace} planted={p?.inject.text} /> : <div className="panel empty">No run selected.</div>}</div>

        {d.history.length > 1 && (
          <div className="section">
            <h2>Every batch of this payload</h2>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="r">#</th>
                    <th>Batch</th>
                    <th>Started</th>
                    <th>Verdict</th>
                    <th>Propagation rate</th>
                    <th>Depths</th>
                    <th>Deployment</th>
                  </tr>
                </thead>
                <tbody>
                  {[...d.history].reverse().map((h, i) => (
                    <tr key={h.batch.id}>
                      <td className="r muted num">{d.history.length - i}</td>
                      <td>
                        <a className="mono" href={`/adversarial/${h.batch.id}`}>{short(h.batch.id, 8)}</a> <span className="small muted">{h.batch.tier}</span>
                        {h.batch.id === d.batch.id && <span className="small muted"> (this one)</span>}
                      </td>
                      <td className="num small">{fmtTime(h.batch.created_at)}</td>
                      <td><SecurityBadge verdict={h.verdict} /></td>
                      <td><RateCell result={h.result} max={h.max_rate} /></td>
                      <td><DepthText result={h.result} /></td>
                      <td><Deployment d={h.deployment} compact /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>
    );
  });
}
