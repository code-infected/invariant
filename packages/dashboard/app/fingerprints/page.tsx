import { isScriptedStandIn, type FingerprintRow } from "@invariant/trace-store";
import { compareFingerprints } from "../../lib/fingerprints";
import { storeRoot } from "../../lib/env";
import { withStore } from "../../lib/store";
import { StoreProblem } from "../../components/store-problem";
import { FpChip, fmtTime, Json, short, SyntheticTag } from "../../components/ui";

export const dynamic = "force-dynamic";

const LABEL = { model_name: "model (requested)", model_version: "model (reported)", system_prompt: "system prompt", tool_schema: "tool schema" } as const;

function Components({ f }: { f: FingerprintRow }) {
  return (
    <dl className="kv">
      <dt>hash</dt>
      <dd className="mono">{f.hash}</dd>
      <dt>model (requested)</dt>
      <dd className="mono">{f.model_name}</dd>
      <dt>model (reported)</dt>
      <dd className="mono">
        {f.model_version} {isScriptedStandIn(f.model_version) && <SyntheticTag />}
      </dd>
      <dt>system prompt</dt>
      <dd>
        <span className="mono small muted">{short(f.system_prompt_hash)}</span>
        <div className="ink2">{f.system_prompt ?? <span className="muted">(not accessible)</span>}</div>
      </dd>
      <dt>tool schema</dt>
      <dd>
        <span className="mono small muted">{short(f.tool_schema_hash)}</span>{" "}
        {(JSON.parse(f.tool_schema_json) as Array<{ name: string }>).map((t) => (
          <span key={t.name} className="mono small" style={{ marginRight: 8 }}>{t.name}</span>
        ))}
      </dd>
      <dt>first seen</dt>
      <dd className="num">{fmtTime(f.first_seen_at)}</dd>
    </dl>
  );
}

export default async function FingerprintsPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  return withStore(storeRoot(), (state) => {
    if (state.kind !== "ok") return <StoreProblem state={state} />;
    const all = state.store.listDeploymentFingerprints();
    const head = (
      <>
        <div className="page-head">
          <h1>Deployment fingerprints</h1>
          <span className="muted">{all.length} recorded</span>
        </div>
        <p className="lede">
          A fingerprint hashes the model asked for, the model the API reported answering, the system prompt, and the exact
          tool list the proxy exposed (keys canonicalised, tool order kept). Its components are stored with it, so a change
          can be read, not just detected.
        </p>
      </>
    );
    const fa = a ? state.store.getDeploymentFingerprint(a) : null;
    const fb = b ? state.store.getDeploymentFingerprint(b) : null;
    if (a && !fa) return <>{head}<div className="panel empty">No fingerprint <code>{a}</code> in this store.</div></>;
    if (b && !fb) return <>{head}<div className="panel empty">No fingerprint <code>{b}</code> in this store.</div></>;
    if (fa && fb) {
      const c = compareFingerprints(state.store, fa.hash, fb.hash)!;
      return (
        <>
          {head}
          <div className={`divergence ${c.changed.length ? "found" : "none"}`}>
            {c.changed.length
              ? `Changed: ${c.changed.map((x) => LABEL[x]).join(", ")}. Unchanged: ${(["model_name", "model_version", "system_prompt", "tool_schema"] as const).filter((x) => !c.changed.includes(x)).map((x) => LABEL[x]).join(", ") || "nothing"}.`
              : "Identical fingerprints."}
          </div>
          <div className="grid2">
            <div className="panel panel-pad"><h2>Before · <FpChip hash={fa.hash} /></h2><Components f={fa} /></div>
            <div className="panel panel-pad"><h2>After · <FpChip hash={fb.hash} /></h2><Components f={fb} /></div>
          </div>
          {c.prompt_diff && (
            <div className="section">
              <h2>System prompt diff</h2>
              <div className="table-wrap">
                <table className="data diff">
                  <tbody>
                    {c.prompt_diff.map((l, i) => (
                      <tr key={i} className={l.op === "match" ? "" : `row-${l.op}`}>
                        <td className="op">{l.op === "match" ? "=" : l.op === "insert" ? "+ added" : l.op === "delete" ? "− removed" : "≠ changed"}</td>
                        <td className={l.op === "delete" || l.op === "substitute" ? "" : "muted"}>{l.before ?? ""}</td>
                        <td>{l.after ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {c.changed.includes("tool_schema") && (
            <div className="section">
              <h2>Tool schema diff{c.reordered ? " (same tools, different order)" : ""}</h2>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {c.tools.filter((t) => t.kind !== "unchanged").map((t) => (
                      <tr key={t.name}>
                        <td className="mono">{t.name}</td>
                        <td><span className="tag tag-warn">{t.kind}</span></td>
                        <td>{t.before !== null && <Json value={t.before} />}</td>
                        <td>{t.after !== null && <Json value={t.after} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      );
    }
    if (fa) {
      return (
        <>
          {head}
          <div className="panel panel-pad">
            <Components f={fa} />
          </div>
          <div className="section">
            <h2>Tools as exposed</h2>
            <Json value={JSON.parse(fa.tool_schema_json)} />
          </div>
        </>
      );
    }
    return (
      <>
        {head}
        {all.length === 0 ? (
          <div className="panel empty">No fingerprints recorded. Runs made before fingerprinting existed have none, and are shown as such.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Fingerprint</th>
                  <th>Model (requested)</th>
                  <th>Model (reported)</th>
                  <th>System prompt</th>
                  <th>Tool schema</th>
                  <th>First seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {all.map((f, i) => (
                  <tr key={f.hash}>
                    <td><FpChip hash={f.hash} /></td>
                    <td className="mono">{f.model_name}</td>
                    <td className="mono">{f.model_version} {isScriptedStandIn(f.model_version) && <SyntheticTag />}</td>
                    <td className="mono small">{short(f.system_prompt_hash)}</td>
                    <td className="mono small">{short(f.tool_schema_hash)}</td>
                    <td className="num small">{fmtTime(f.first_seen_at)}</td>
                    <td>{i > 0 && <a className="small" href={`/fingerprints?a=${all[i - 1]!.hash}&b=${f.hash}`}>diff vs previous</a>}</td>
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
