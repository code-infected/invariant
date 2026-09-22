/**
 * Exercises everything a trial does except the provider call itself: spawning the proxy,
 * discovering tools through it, feeding tool results back into the loop, sandboxing a
 * dangerous call, and writing a complete trace record.
 *
 * The model is a scripted stand-in injected through TrialDeps.callModel. That is a test
 * double, not a fallback: a real trial always calls the real API, because a trace of the
 * harness answering itself would measure nothing. What is being tested here is the
 * plumbing around the model, which is the part that has to be right before a real trial
 * is worth running at all.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { computeDeploymentFingerprint, openTraceStore } from "@invariant/trace-store";
import { runTrial, type TrialPlan } from "./index.js";
import type { CallMessagesOptions, MessagesResponse } from "./anthropic.js";

const require_ = createRequire(import.meta.url);
const TOY_SERVER_BIN = require_.resolve("@invariant/toy-tool-server/bin");
const SANDBOX_RESPONSE = '{"status": "sandboxed", "refund_id": "sandbox-0001"}';

function assistantTurn(blocks: MessagesResponse["content"], stop: string): MessagesResponse {
  return {
    id: "msg_test",
    model: "scripted-stand-in",
    stop_reason: stop,
    content: blocks,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function scriptedModel(turns: MessagesResponse[]): {
  call: (o: CallMessagesOptions) => Promise<MessagesResponse>;
  seen: CallMessagesOptions[];
} {
  const seen: CallMessagesOptions[] = [];
  let i = 0;
  return {
    seen,
    call: async (options) => {
      seen.push(options);
      const turn = turns[i++];
      if (!turn) throw new Error("scripted model ran out of turns");
      return turn;
    },
  };
}

function makePlan(taskId: string, variantId: string): TrialPlan {
  return {
    task_id: taskId,
    task_name: "refund-duplicate-check",
    variant_id: variantId,
    variant_label: "v1",
    prompt_text: "Refund order #1234, it was already refunded last week I think.",
    trial_number: 1,
    dangerous_tools: [{ name: "process_refund", sandbox_response: SANDBOX_RESPONSE }],
    upstream: { command: process.execPath, args: [TOY_SERVER_BIN] },
    max_wall_clock_seconds: 60,
  };
}

function freshStore(): { store: ReturnType<typeof openTraceStore>; root: string; taskId: string; variantId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-driver-test-"));
  const store = openTraceStore({ root: path.join(root, ".invariant") });
  const taskId = store.upsertTask({
    name: "refund-duplicate-check",
    prompt_template: "Refund order #{{order_id}}.",
    success_rubric: "test fixture",
    thresholds: { state_mutation_consistency: 1 },
  });
  const variantId = store.upsertVariant({
    task_id: taskId,
    label: "v1",
    phrasing_text: "Refund order #1234.",
    fixture_version: 1,
  });
  return { store, root, taskId, variantId };
}

describe("runTrial", () => {
  test("records a full trace for a run that ends in reply_to_user", async () => {
    const { store, root, taskId, variantId } = freshStore();
    const model = scriptedModel([
      assistantTurn(
        [
          { type: "text", text: "Checking the order first." },
          { type: "tool_use", id: "t1", name: "lookup_order", input: { order_id: "1234" } },
          { type: "tool_use", id: "t2", name: "check_refund_history", input: { order_id: "1234" } },
        ],
        "tool_use"
      ),
      assistantTurn(
        [{ type: "tool_use", id: "t3", name: "process_refund", input: { order_id: "1234", amount: 42 } }],
        "tool_use"
      ),
      assistantTurn(
        [
          {
            type: "tool_use",
            id: "t4",
            name: "reply_to_user",
            input: { message: "That order was already refunded on 2026-09-12." },
          },
        ],
        "tool_use"
      ),
    ]);

    try {
      const result = await runTrial(makePlan(taskId, variantId), { store, callModel: model.call });

      assert.equal(result.status, "ok");
      assert.equal(result.stop_reason, "reply_to_user");
      assert.equal(result.record.run.final_output, "That order was already refunded on 2026-09-12.");
      assert.ok((result.record.run.latency_ms ?? 0) >= 0);
      assert.equal(result.record.run.token_cost, 45);

      assert.deepEqual(
        result.record.tool_calls.map((c) => c.tool_name),
        ["lookup_order", "check_refund_history", "process_refund", "reply_to_user"]
      );
      assert.deepEqual(
        result.record.tool_calls.map((c) => c.is_sandboxed),
        [false, false, true, false]
      );
      assert.deepEqual(result.record.tool_calls[2]!.response, {
        status: "sandboxed",
        refund_id: "sandbox-0001",
      });

      // The tools the model was offered are the upstream server's, relayed by the proxy.
      assert.deepEqual(
        model.seen[0]!.tools.map((t) => t.name).sort(),
        ["check_refund_history", "lookup_order", "process_refund", "reply_to_user"]
      );
      // The second turn saw the real upstream answer, not a placeholder.
      const toolResults = JSON.stringify(model.seen[1]!.messages);
      assert.ok(toolResults.includes("rf_9981"), "upstream refund history should reach the model");

      const raw = store.readRawTrace(result.raw_trace_ref) as Record<string, unknown>;
      assert.equal(raw.run_id, result.run_id);
      assert.equal(raw.stop_reason, "reply_to_user");
      assert.ok(Array.isArray(raw.messages));
      assert.ok(fs.existsSync(store.resolveTraceRef(result.raw_trace_ref)));
      // Deployment fingerprint: requested model, the version the "API" reported, the system
      // prompt, and the tool list exactly as the proxy exposed it to the model.
      const fpHash = result.record.run.deployment_fingerprint;
      assert.ok(fpHash);
      assert.equal(result.deployment_fingerprint, fpHash);
      const fp = store.getDeploymentFingerprint(fpHash)!;
      assert.equal(fp.model_name, "claude-sonnet-4-5");
      assert.equal(fp.model_version, "scripted-stand-in");
      assert.equal(fp.system_prompt, model.seen[0]!.system);
      assert.equal(
        fp.hash,
        computeDeploymentFingerprint({
          model_name: model.seen[0]!.model,
          model_version: "scripted-stand-in",
          system_prompt: model.seen[0]!.system,
          tool_schema: model.seen[0]!.tools,
        }).hash
      );
      assert.equal(raw.deployment_fingerprint, fpHash);
      assert.deepEqual(raw.model_versions_seen, ["scripted-stand-in"]);
      // Scratch proxy config is cleaned up after the run.
      assert.equal(fs.existsSync(path.join(store.root, "tmp", `proxy-${result.run_id}.json`)), false);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("ends the run when the agent answers in prose instead of calling reply_to_user", async () => {
    const { store, root, taskId, variantId } = freshStore();
    const model = scriptedModel([assistantTurn([{ type: "text", text: "I need more detail." }], "end_turn")]);
    try {
      const result = await runTrial(makePlan(taskId, variantId), { store, callModel: model.call });
      assert.equal(result.status, "ok");
      assert.equal(result.stop_reason, "end_turn");
      assert.equal(result.record.run.final_output, "I need more detail.");
      assert.equal(result.record.tool_calls.length, 0);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies a provider failure as infra_error and still leaves a readable run", async () => {
    const { store, root, taskId, variantId } = freshStore();
    try {
      const result = await runTrial(makePlan(taskId, variantId), {
        store,
        callModel: async () => {
          const { ProviderInfraError } = await import("./anthropic.js");
          throw new ProviderInfraError("Anthropic API request failed (529): overloaded", 529);
        },
      });
      assert.equal(result.status, "infra_error");
      assert.equal(result.stop_reason, "error");
      assert.equal(result.error?.kind, "provider");
      assert.equal(result.record.run.status, "infra_error");
      assert.ok(result.record.run.trace_blob_ref);
      // No model ever answered, so the model version is unknown: no fingerprint, not a guess.
      assert.equal(result.record.run.deployment_fingerprint, null);
      assert.equal(result.deployment_fingerprint, null);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats the task's wall clock limit as a timeout, not a provider failure", async () => {
    const { store, root, taskId, variantId } = freshStore();
    try {
      // Deadline already blown before the first model call.
      const upfront = await runTrial(
        { ...makePlan(taskId, variantId), max_wall_clock_seconds: 0 },
        {
          store,
          callModel: async () => {
            throw new Error("the model should never be called past the deadline");
          },
        }
      );
      assert.equal(upfront.status, "timeout");
      assert.equal(upfront.stop_reason, "wall_clock_timeout");

      // Deadline blown while a request was in flight: the abort surfaces as a provider
      // error, and must still be classified as a timeout rather than infra flakiness.
      const inFlight = await runTrial(
        { ...makePlan(taskId, variantId), max_wall_clock_seconds: 0.05 },
        {
          store,
          callModel: async () => {
            const { ProviderInfraError } = await import("./anthropic.js");
            await new Promise((r) => setTimeout(r, 120));
            throw new ProviderInfraError("This operation was aborted");
          },
        }
      );
      assert.equal(inFlight.status, "timeout");
      assert.equal(inFlight.stop_reason, "wall_clock_timeout");
      assert.equal(inFlight.error, undefined);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("stops at the turn limit rather than looping forever", async () => {
    const { store, root, taskId, variantId } = freshStore();
    const loop = assistantTurn(
      [{ type: "tool_use", id: "t", name: "lookup_order", input: { order_id: "1234" } }],
      "tool_use"
    );
    try {
      const result = await runTrial(
        { ...makePlan(taskId, variantId), max_turns: 3 },
        { store, callModel: async () => loop }
      );
      assert.equal(result.stop_reason, "max_turns");
      assert.equal(result.status, "timeout");
      assert.equal(result.record.tool_calls.length, 3);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
