import { notFound } from "next/navigation";
import type { FingerprintComponent } from "@invariant/trace-store";
import { storeRoot, tasksDir } from "../../../lib/env";
import { loadSpecs } from "../../../lib/specs";
import { withStore } from "../../../lib/store";
import { getTrend, type Trend, type TrendPoint } from "../../../lib/trend";
import { StoreProblem } from "../../../components/store-problem";
import { Deployment, fmtScore, fmtTime, FpChip, short, SyntheticTag, VerdictBadge } from "../../../components/ui";
import { isScriptedStandIn } from "@invariant/trace-store";
import { buildSecurityBoard } from "../../../lib/adversarial";
import { SecurityTable } from "../../../components/security";

export const dynamic = "force-dynamic";

const COMPONENT_SHORT: Record<FingerprintComponent, string> = {
  provider: "provider",
  endpoint: "endpoint",
  model_name: "model",
  model_version: "model version",
  system_prompt: "system prompt",
  tool_schema: "tool schema",
};

type AxisKey = "state_mutation" | "tool_path" | "outcome";
const PANELS: Array<{ key: AxisKey; label: string; color: string; thr: "state_mutation_consistency" | "tool_path_consistency_min" | "outcome_consistency_min"; shape: "circle" | "square" | "diamond" }> = [
  { key: "state_mutation", label: "state-mutation", color: "var(--s-sm)", thr: "state_mutation_consistency", shape: "circle" },
  { key: "tool_path", label: "tool-path", color: "var(--s-tp)", thr: "tool_path_consistency_min", shape: "square" },
  { key: "outcome", label: "outcome", color: "var(--s-oc)", thr: "outcome_consistency_min", shape: "diamond" },
];

function Marker({ shape, x, y, color, hollow }: { shape: string; x: number; y: number; color: string; hollow?: boolean }) {
  const common = { fill: hollow ? "var(--surface)" : color, stroke: hollow ? "var(--muted)" : "var(--surface)", strokeWidth: 2 };
  if (shape === "square") return <rect x={x - 4.5} y={y - 4.5} width={9} height={9} {...common} />;
  if (shape === "diamond") return <path d={`M${x} ${y - 6} L${x + 6} ${y} L${x} ${y + 6} L${x - 6} ${y} Z`} {...common} />;
  return <circle cx={x} cy={y} r={5} {...common} />;
}

/** Small multiples: one panel per axis, shared x (batch order), threshold dashed, fingerprint changes marked. */
function TrendChart({ trend }: { trend: Trend }) {
  const pts = trend.points;
  const W = 1000;
  const L = 118;
  const R = 16;
  const TOP = 34;
  const PH = 78;
  const GAP = 28;
  const step = (W - L - R) / Math.max(1, pts.length);
  const x = (i: number) => L + (i + 0.5) * step;
  const panelTop = (p: number) => TOP + p * (PH + GAP);
  const y = (p: number, v: number) => panelTop(p) + (1 - v) * PH;
  const H = panelTop(PANELS.length) + 30;
  const changes = pts.flatMap((pt) => pt.changes.map((c) => ({ pt, c })));
  return (
    <div className="chart panel panel-pad">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Axis scores across ${pts.length} batches of ${trend.task.name}`}>
        {changes.map(({ pt, c }, k) => {
          const cx = c.within_batch ? x(pt.index) : x(pt.index) - step / 2;
          // A formula-only change (same deployment, new hashing formula) is drawn muted and
          // labelled as such: it must not read as a deploy.
          const text = c.formula_only
            ? `fingerprint formula${c.formula_versions ? ` v${c.formula_versions[0]}→v${c.formula_versions[1]}` : ""} (same deployment)`
            : `Δ ${c.components.map((x) => COMPONENT_SHORT[x]).join(" + ") || "fingerprint"}${c.within_batch ? " (mid-batch)" : ""}`;
          return (
            <g key={k}>
              <line className={c.formula_only ? "fpmark fpmark-formula" : "fpmark"} x1={cx} x2={cx} y1={TOP - 12} y2={panelTop(PANELS.length) - GAP + 2} />
              <text className={c.formula_only ? "fplbl fplbl-formula" : "fplbl"} x={cx + 4} y={TOP - 16 + (k % 2) * -0} textAnchor="start">
                {text}
              </text>
              <title>{`${short(c.from)} → ${short(c.to)}: ${c.formula_only ? "formula change only, no recorded component differs" : c.components.join(", ")}`}</title>
            </g>
          );
        })}
        {PANELS.map((panel, p) => {
          const th = trend.thresholds?.thresholds[panel.thr];
          const series = pts.map((pt) => ({ pt, v: pt[panel.key] }));
          const segments: string[] = [];
          let cur = "";
          for (const s of series) {
            if (s.v === null) {
              if (cur) segments.push(cur);
              cur = "";
              continue;
            }
            cur += `${cur ? "L" : "M"}${x(s.pt.index)} ${y(p, s.v)} `;
          }
          if (cur) segments.push(cur);
          return (
            <g key={panel.key}>
              <text className="lbl" x={0} y={panelTop(p) + 12}>{panel.label}</text>
              {th !== undefined && (
                <text x={0} y={panelTop(p) + 27}>threshold ≥ {th.toFixed(2)}</text>
              )}
              {[0, 0.5, 1].map((g) => (
                <g key={g}>
                  <line className={g === 0 ? "base" : "grid"} x1={L} x2={W - R} y1={y(p, g)} y2={y(p, g)} />
                  <text x={L - 6} y={y(p, g) + 4} textAnchor="end">{g.toFixed(1)}</text>
                </g>
              ))}
              {th !== undefined && <line className="thr" x1={L} x2={W - R} y1={y(p, th)} y2={y(p, th)} />}
              {segments.map((d, i) => (
                <path key={i} d={d} fill="none" stroke={panel.color} strokeWidth={2} />
              ))}
              {series.map(({ pt, v }) =>
                v === null ? (
                  <g key={pt.index}>
                    <Marker shape={panel.shape} x={x(pt.index)} y={y(p, 0) - 8} color={panel.color} hollow />
                    <text className="nc" x={x(pt.index) + 9} y={y(p, 0) - 5}>{pt.scored ? "not computed" : "not scored"}</text>
                    <title>{`batch #${pt.index + 1}: ${panel.label} ${pt.scored ? "not computed" : "batch not scored"}`}</title>
                  </g>
                ) : (
                  <g key={pt.index}>
                    <Marker shape={panel.shape} x={x(pt.index)} y={y(p, v)} color={panel.color} />
                    <title>{`batch #${pt.index + 1} ${short(pt.batch.id, 8)}: ${panel.label} ${v.toFixed(3)}${th !== undefined ? (v + 1e-9 >= th ? " (pass)" : " (FAIL)") : ""}`}</title>
                  </g>
                )
              )}
            </g>
          );
        })}
        {pts.map((pt) => (
          <text key={pt.index} x={x(pt.index)} y={H - 12} textAnchor="middle">
            #{pt.index + 1} · {short(pt.dominant, 6)}
          </text>
        ))}
      </svg>
      <div className="small muted" style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
        <span>x: batches in order (label: # and dominant fingerprint)</span>
        <span>– – threshold</span>
        <span style={{ color: "var(--warn)" }}>┆ Δ fingerprint change (component named)</span>
        <span className="muted">┆ grey: fingerprint formula changed, same deployment</span>
        <span>hollow marker: no score</span>
      </div>
    </div>
  );
}

function ChangeText({ pt }: { pt: TrendPoint }) {
  if (pt.changes.length === 0) return <span className="muted">–</span>;
  return (
    <div className="fp-list">
      {pt.changes.map((c, i) => (
        <a key={i} href={`/fingerprints?a=${c.from}&b=${c.to}`} className="small">
          {c.formula_only ? (
            <span className="tag">formula{c.formula_versions ? ` v${c.formula_versions[0]}→v${c.formula_versions[1]}` : ""}, same deployment</span>
          ) : (
            <span className="tag tag-warn">Δ {c.components.map((x) => COMPONENT_SHORT[x]).join(" + ")}</span>
          )}{" "}
          {c.within_batch ? "mid-batch" : "since previous"}: <span className="mono">{short(c.from, 8)} → {short(c.to, 8)}</span>
        </a>
      ))}
    </div>
  );
}

export default async function TaskTrendPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const taskName = decodeURIComponent(name);
  const specs = loadSpecs(tasksDir());
  return withStore(storeRoot(), (state) => {
    if (state.kind !== "ok") return <StoreProblem state={state} />;
    const trend = getTrend(state.store, taskName, specs);
    if (!trend) notFound();
    const fps = trend.fingerprints.map((h) => state.store.getDeploymentFingerprint(h)!).filter(Boolean);
    return (
      <>
        <div className="crumbs">
          <a href="/">Leaderboard</a> / task
        </div>
        <div className="page-head">
          <h1 className="mono">{trend.task.name}</h1>
          <span className="muted">{trend.points.length} finished batch{trend.points.length === 1 ? "" : "es"}</span>
        </div>
        <p className="lede">
          Axis scores per batch, plotted against deployment fingerprints: a vertical marker is a change of provider,
          endpoint, model, model version, system prompt or tool schema, so a regression can be pinned to the deploy that
          introduced it. A grey marker is a change of fingerprint formula only (same deployment, hashed differently).
          {trend.thresholds && <> Thresholds from {trend.thresholds.source}.</>}
        </p>
        {trend.points.length === 0 ? (
          <div className="panel empty">No finished batches for this task.</div>
        ) : (
          <TrendChart trend={trend} />
        )}

        <div className="section">
          <h2>Batches</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>Batch</th>
                  <th>Started</th>
                  <th className="r">State-mut.</th>
                  <th className="r">Tool-path</th>
                  <th className="r">Outcome</th>
                  <th className="r">Scored / runs</th>
                  <th>Verdict</th>
                  <th>Fingerprints</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {[...trend.points].reverse().map((pt) => (
                  <tr key={pt.batch.id}>
                    <td className="r muted num">{pt.index + 1}</td>
                    <td>
                      <a className="mono" href={`/batches/${pt.batch.id}`}>{short(pt.batch.id, 8)}</a>{" "}
                      <span className="small muted">{pt.batch.tier}</span>
                    </td>
                    <td className="num small">{fmtTime(pt.batch.created_at)}</td>
                    <td className="r mono">{fmtScore(pt.state_mutation)}</td>
                    <td className="r mono">{fmtScore(pt.tool_path)}</td>
                    <td className="r mono">{pt.scored ? (pt.outcome === null ? <span className="muted">n/c</span> : fmtScore(pt.outcome)) : <span className="muted">–</span>}</td>
                    <td className="r mono">{pt.runs_scored ?? "–"} / {pt.runs_total}</td>
                    <td>{pt.scored ? <VerdictBadge verdict={pt.verdict} /> : <span className="muted small">not scored</span>}</td>
                    <td><Deployment d={pt.deployment} compact /></td>
                    <td><ChangeText pt={pt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {(() => {
          const security = buildSecurityBoard(state.store, tasksDir(), trend.task.name);
          if (security.length === 0) return null;
          return (
            <div className="section">
              <h2>Security: adversarial payloads (separate from the consistency trend above)</h2>
              <SecurityTable rows={security} showTask={false} />
            </div>
          );
        })()}

        <div className="section">
          <h2>Fingerprints seen, in order</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Fingerprint</th>
                  <th>Model (requested)</th>
                  <th>Model (reported by API)</th>
                  <th>System prompt</th>
                  <th>Tool schema</th>
                  <th>First seen</th>
                </tr>
              </thead>
              <tbody>
                {fps.map((f, i) => (
                  <tr key={f.hash}>
                    <td><FpChip hash={f.hash} /> {i > 0 && <a className="small" href={`/fingerprints?a=${fps[i - 1]!.hash}&b=${f.hash}`}>diff vs previous</a>}</td>
                    <td className="mono">{f.model_name}</td>
                    <td className="mono">{f.model_version} {isScriptedStandIn(f.model_version) && <SyntheticTag />}</td>
                    <td className="mono small">{short(f.system_prompt_hash)}</td>
                    <td className="mono small">{short(f.tool_schema_hash)} <span className="muted">({(JSON.parse(f.tool_schema_json) as unknown[]).length} tools)</span></td>
                    <td className="num small">{fmtTime(f.first_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  });
}
