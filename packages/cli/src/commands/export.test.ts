/**
 * `invariant export` end to end, minus the network: a SYNTHETIC scripted batch of the code
 * task (code-cleanup-fixture.ts, not a model) written through the real proxy, scored,
 * then exported through the real command into the SDK's in-memory exporter. The real OTLP
 * path is verified against a live Jaeger outside the test suite (see the README).
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { openTraceStore } from "@invariant/trace-store";
import { loadConfig } from "../lib/config.js";
import { loadValidTask } from "../lib/load-tasks.js";
import { expandEnv, resolveOtelEndpoint } from "../lib/otel.js";
import { parseConfig } from "../lib/config.js";
import { scoreStoredBatch } from "./score.js";
import { writeCodeCleanupBatch } from "./code-cleanup-fixture.js";
import { runExport } from "./export.js";
import { clearConfiguredCredentials } from "../lib/models.js";

class KeepSpans extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe("invariant export on a SYNTHETIC batch (scripted stand-in, not a live model)", () => {
  let root: string;
  let storeRoot: string;
  let batchId: string;
  let restoreCredentials: () => void = () => undefined;

  before(async () => {
    restoreCredentials = clearConfiguredCredentials(loadConfig());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-export-test-"));
    storeRoot = path.join(root, ".invariant");
    const store = openTraceStore({ root: storeRoot });
    try {
      const task = loadValidTask("code-agent-destructive-command");
      batchId = (await writeCodeCleanupBatch(store, task)).batch_id;
      await scoreStoredBatch(store, store.getBatch(batchId)!, task, loadConfig());
    } finally {
      store.close();
    }
  });
  after(() => {
    restoreCredentials();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("exports the batch: sandboxed deletes marked, the state-mutation failure on the batch span", async () => {
    const exporter = new KeepSpans();
    const lines: string[] = [];
    const report = await runExport(
      { task: "code-agent-destructive-command", endpoint: "http://collector.example:4318" },
      { storeRoot, exporter, out: (l) => lines.push(l), err: (l) => lines.push(l) }
    );
    const spans = exporter.getFinishedSpans();
    assert.equal(report.batches[0]!.batch_id, batchId);
    assert.equal(report.endpoint, "http://collector.example:4318/v1/traces");
    assert.equal(report.endpoint_source, "--endpoint");
    assert.equal(spans.length, report.batches[0]!.spans);
    assert.equal(spans.length, 1 + 5 + (7 * 3 + 8 + 3));
    const root = spans.find((s) => s.name === "invariant.batch")!;
    assert.equal(root.attributes["invariant.axis.state_mutation"], 0.6);
    assert.equal(root.attributes["invariant.axis.state_mutation.result"], "fail");
    assert.equal(root.attributes["invariant.thresholds.source"], "tasks/code-agent-destructive-command.yaml");
    assert.equal(root.attributes["invariant.synthetic"], true);
    const shell = spans.filter((s) => s.name === "execute_tool run_shell_command");
    assert.equal(shell.length, 1);
    assert.equal(shell[0]!.attributes["invariant.tool.sandboxed"], true);
    assert.equal(shell[0]!.attributes["gen_ai.tool.call.arguments"], '{"command":"rm -rf build/*"}');
    assert.ok(spans.filter((s) => s.name === "execute_tool list_files").every((s) => s.attributes["invariant.tool.sandboxed"] === false));
    assert.match(lines.join("\n"), /spans\s+: 38 \(1 batch, 5 run\(s\), 32 tool call\(s\), 22 sandboxed\)/);
  });

  test("--dry-run prints the tree and sends nothing; bad selections are refused", async () => {
    const exporter = new KeepSpans();
    const lines: string[] = [];
    await runExport({ batch: batchId, dryRun: true }, { storeRoot, exporter, out: (l) => lines.push(l), err: () => {} });
    assert.equal(exporter.getFinishedSpans().length, 0);
    assert.match(lines[0]!, /dry run: nothing sent/);
    assert.match(lines.join("\n"), /invoke_agent .* v1 trial 5 attempt 1/);
    assert.match(lines.join("\n"), /execute_tool run_shell_command .* SANDBOXED/);
    await assert.rejects(runExport({}, { storeRoot, exporter }), /exactly one of/);
    await assert.rejects(runExport({ batch: "nope" }, { storeRoot, exporter }), /no batch with id nope/);
  });

  test("endpoint: --endpoint, then OTEL_EXPORTER_OTLP_ENDPOINT, then the config (with ${VAR}), then the default", () => {
    const parsed = parseConfig(`
providers: { retry: { max_attempts: 1, retry_on: [429] } }
execution: { worker_concurrency: 1, default_tier: smoke }
export: { otel_endpoint: "\${MY_COLLECTOR}" }
`);
    assert.ok(parsed.ok);
    const config = parsed.ok ? parsed.config : null;
    assert.equal(resolveOtelEndpoint("http://flag:4318", config, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" }).source, "--endpoint");
    assert.deepEqual(resolveOtelEndpoint(undefined, config, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" }), {
      endpoint: "http://env:4318",
      source: "OTEL_EXPORTER_OTLP_ENDPOINT",
    });
    assert.equal(resolveOtelEndpoint(undefined, config, { MY_COLLECTOR: "http://cfg:4318" }).endpoint, "http://cfg:4318");
    assert.deepEqual(resolveOtelEndpoint(undefined, config, {}), { endpoint: "http://localhost:4318", source: "default" });
    assert.equal(expandEnv("${A}/x/${B}", { A: "a" }), "a/x/");
    // The committed config names the standard variable.
    assert.equal(loadConfig().export?.otel_endpoint, "${OTEL_EXPORTER_OTLP_ENDPOINT}");
  });
});
