import type { StoreState } from "../lib/store";

export function StoreProblem({ state }: { state: StoreState }) {
  if (state.kind === "ok") return null;
  const title =
    state.kind === "missing" ? "No trace store yet" : state.kind === "outdated" ? "Trace store needs migrating" : "Cannot read the trace store";
  return (
    <div className="panel empty">
      <h1>{title}</h1>
      <p className="lede">
        {state.kind === "missing" && (
          <>
            Nothing at <code>{state.root}/trace.db</code>. The dashboard only reads; it never creates a store.
          </>
        )}
        {state.kind !== "missing" && "message" in state && state.message}
      </p>
      {state.kind === "missing" && (
        <pre>{`invariant run --tier=smoke                     # real runs (needs the models.agent key; see invariant doctor)
invariant demo-seed --store=.invariant-demo    # SYNTHETIC demo data
invariant dashboard --store=.invariant-demo`}</pre>
      )}
    </div>
  );
}
