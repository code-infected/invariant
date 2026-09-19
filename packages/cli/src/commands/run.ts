import { createRequire } from "node:module";
import path from "node:path";
import { openTraceStore } from "@invariant/trace-store";
import { requireApiKey, runTrial, type TrialPlan } from "@invariant/agent-driver";
import type { UpstreamConfig } from "@invariant/mcp-proxy";
import { loadTask } from "../lib/load-tasks.js";
import { INVARIANT_DIR, REPO_ROOT } from "../lib/paths.js";

const require_ = createRequire(import.meta.url);

/**
 * The tool server the proxy forwards to.
 *
 * Hardcoded to the toy server for now, on purpose: this milestone proves the
 * instrumentation path end to end, and the toy server is the only tool server in the
 * repo. Pointing the harness at somebody else's real MCP server is a per-target
 * deployment decision (see the proxy notes in internal-docs/TECHNICAL_SPEC.md section 8),
 * so it belongs in invariant.config.yaml once there is a second target to configure for,
 * not in an invented config key nothing reads yet.
 */
function defaultUpstream(): UpstreamConfig {
  return {
    command: process.execPath,
    args: [require_.resolve("@invariant/toy-tool-server/bin")],
  };
}

export interface RunOptions {
  task: string;
  variant: string;
  trial: number;
  model?: string;
  json: boolean;
}

export async function runRun(opts: RunOptions): Promise<void> {
  // Fail before touching the trace store, so a missing key does not leave a half-open run.
  requireApiKey();

  const task = loadTask(opts.task);
  const hardErrors = task.errors.filter((e) => !e.startsWith("warning:"));
  if (hardErrors.length > 0) {
    throw new Error(
      `task "${opts.task}" is not valid, refusing to run it:\n` + hardErrors.map((e) => `  - ${e}`).join("\n")
    );
  }
  const fixture = task.fixture!;
  const variant = fixture.variants.find((v) => v.id === opts.variant);
  if (!variant) {
    throw new Error(
      `no variant "${opts.variant}" in tasks/${opts.task}.variants.json. ` +
        `Available: ${fixture.variants.map((v) => v.id).join(", ")}`
    );
  }

  const store = openTraceStore({ root: INVARIANT_DIR });
  try {
    const taskId = store.upsertTask({
      name: task.spec.name,
      prompt_template: task.spec.prompt_template,
      success_rubric: task.spec.success_rubric,
      dangerous_tools: task.spec.tools.dangerous,
      volatile_fields: task.spec.volatile_fields,
      thresholds: task.spec.thresholds,
    });
    const variantId = store.upsertVariant({
      task_id: taskId,
      label: variant.id,
      phrasing_text: variant.text,
      fixture_version: fixture.fixture_version,
      approved_by: fixture.approved_by,
      generated_at: fixture.generated_at,
    });

    const plan: TrialPlan = {
      task_id: taskId,
      task_name: task.spec.name,
      variant_id: variantId,
      variant_label: variant.id,
      prompt_text: variant.text,
      trial_number: opts.trial,
      dangerous_tools: task.spec.tools.dangerous,
      upstream: defaultUpstream(),
      max_wall_clock_seconds: task.spec.execution.max_wall_clock_seconds,
      model: opts.model,
    };

    console.log(`Running ${task.spec.name} / variant ${variant.id} / trial ${opts.trial}`);
    console.log(`  prompt: ${variant.text}`);
    console.log("");

    const result = await runTrial(plan, { store, log: (m) => console.error(m) });

    if (opts.json) {
      console.log(JSON.stringify(result.record, null, 2));
    } else {
      printRecord(result.record.run.id, result);
    }
    console.log("");
    console.log(`  trace record : ${path.relative(REPO_ROOT, store.dbPath)} (run ${result.run_id})`);
    console.log(`  raw trace    : ${path.relative(REPO_ROOT, store.resolveTraceRef(result.raw_trace_ref))}`);

    if (result.status !== "ok") {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function printRecord(runId: string, result: Awaited<ReturnType<typeof runTrial>>): void {
  const { record } = result;
  console.log(`Run ${runId}`);
  console.log(`  status       : ${result.status} (${result.stop_reason})`);
  if (result.error) console.log(`  error        : [${result.error.kind}] ${result.error.message}`);
  console.log(`  latency      : ${record.run.latency_ms} ms`);
  console.log(`  tokens       : ${record.run.token_cost}`);
  console.log(`  tool calls   : ${record.tool_calls.length}`);
  for (const call of record.tool_calls) {
    const flag = call.is_sandboxed ? " [SANDBOXED]" : "";
    console.log(`    ${call.sequence_index}. ${call.tool_name}${flag} ${JSON.stringify(call.args)}`);
    console.log(`       -> ${JSON.stringify(call.response)}`);
  }
  console.log(`  final output :`);
  for (const line of (record.run.final_output ?? "(none)").split("\n")) {
    console.log(`    ${line}`);
  }
}
