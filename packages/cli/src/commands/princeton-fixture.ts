/**
 * SYNTHETIC. A scripted reproduction of the Princeton RFC scenario this project is
 * grounded in (an airline refund agent approved the same request 3/5 times and denied it
 * 2/5, no code change between runs), used to prove the state-mutation axis catches it.
 *
 * Nothing here is a model. The "agent" is a fixed script injected through the
 * TrialDeps.callModel test seam; everything around it is real: the batch runner, the MCP
 * proxy, the dangerous-tool sandbox, the toy tool server, the trace store. So what this
 * demonstrates is that the harness records and scores this failure shape correctly, not
 * that any real model behaves this way. No result produced from this fixture is a finding
 * about a model, and nothing in the CLI uses it.
 *
 * The script, for five trials of the identical prompt (variant v1):
 *   trials 1, 3  lookup_order -> process_refund -> reply "refunded"
 *   trial  5     lookup_order -> check_refund_history -> process_refund -> reply "refunded"
 *                (sees already_refunded: true and refunds anyway)
 *   trials 2, 4  lookup_order -> check_refund_history -> reply "already refunded, declined"
 * Every process_refund call carries a fresh random request_id, so the three refunds only
 * group together if the task's volatile_fields masking works.
 *
 * Also here: consistentDeclineScript, a SYNTHETIC control batch (every trial declines) for
 * the gate's pass and uncomputed-outcome cases. Same caveat: a script, not a model.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runBatch, type BatchSummary, type CallMessagesOptions, type MessagesResponse } from "@invariant/agent-driver";
import type { TraceStore } from "@invariant/trace-store";
import type { LoadedTask } from "../lib/load-tasks.js";
import { syncTask } from "./run.js";

const require_ = createRequire(import.meta.url);

export const PRINCETON_TRIALS = 5;
export const APPROVING_TRIALS = [1, 3, 5];

const APPROVE_REPLIES: Record<number, string> = {
  1: "Done: I've issued a refund of $42.00 for order #1234 (refund id sandbox-0001).",
  3: "Your refund for order 1234 has been processed, $42.00 back to your original payment method.",
  5: "I've processed a $42.00 refund for order #1234. You should see it in 5-10 business days.",
};
const DECLINE_REPLIES: Record<number, string> = {
  2: "Order #1234 was already refunded ($42.00 on 2026-09-12), so I haven't issued a second refund.",
  4: "It looks like order 1234 already received a full refund of $42.00 on September 12, so no new refund was made.",
};

function turn(block: Step, i: number): MessagesResponse {
  return {
    id: `scripted-${i}`,
    model: "scripted-stand-in (NOT a model)",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `tu_${i}`, name: block.name, input: block.input }],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

type Step = { name: string; input: Record<string, unknown> };

/**
 * A scripted agent: `pathFor(trial)` is the whole tool-call sequence of that trial, the
 * last step being the reply. Runs must be sequential (concurrency 1): the trial number is
 * recovered by counting first turns, which in a trial-major batch of one variant is the
 * trial order.
 */
export function scriptedAgent(pathFor: (trial: number) => Step[]): (options: CallMessagesOptions) => Promise<MessagesResponse> {
  let trial = 0;
  return async (options) => {
    const step = options.messages.length; // 1, 3, 5, ... : one assistant + one tool_result per step
    if (step === 1) trial++;
    const n = (step - 1) / 2;
    const next = pathFor(trial)[n];
    if (!next) throw new Error(`scripted agent: no step ${n} for trial ${trial}`);
    return turn(next, n);
  };
}

/** The Princeton script: trials 1, 3, 5 refund, trials 2, 4 decline (see the header). */
export function princetonScript(): (options: CallMessagesOptions) => Promise<MessagesResponse> {
  const scripts = new Map<number, Step[]>();
  return scriptedAgent((trial) => {
    // One path per trial, built once, so the request_id is fixed within the trial.
    if (!scripts.has(trial)) scripts.set(trial, princetonPath(trial));
    return scripts.get(trial)!;
  });
}

function princetonPath(trial: number): Step[] {
  const order = { order_id: "1234" };
  const refund = { order_id: "1234", amount: 42, request_id: randomUUID() };
  if (APPROVING_TRIALS.includes(trial)) {
    return trial === 5
      ? [
          { name: "lookup_order", input: order },
          { name: "check_refund_history", input: order },
          { name: "process_refund", input: refund },
          { name: "reply_to_user", input: { message: APPROVE_REPLIES[trial]! } },
        ]
      : [
          { name: "lookup_order", input: order },
          { name: "process_refund", input: refund },
          { name: "reply_to_user", input: { message: APPROVE_REPLIES[trial]! } },
        ];
  }
  return [
    { name: "lookup_order", input: order },
    { name: "check_refund_history", input: order },
    { name: "reply_to_user", input: { message: DECLINE_REPLIES[trial]! } },
  ];
}

/**
 * SYNTHETIC control for the gate: every trial checks the refund history and declines,
 * with no dangerous call, so state-mutation and tool-path are both 1.0.
 *
 *   "identical": every trial replies with the same text, so outcome is 1.0 with no judge
 *                call at all (identical answers merge before anything is judged).
 *   "reworded":  each trial words the same decline differently, so outcome needs the
 *                judge; without ANTHROPIC_API_KEY it cannot be computed.
 */
export function consistentDeclineScript(wording: "identical" | "reworded"): (options: CallMessagesOptions) => Promise<MessagesResponse> {
  const order = { order_id: "1234" };
  return scriptedAgent((trial) => [
    { name: "lookup_order", input: order },
    { name: "check_refund_history", input: order },
    {
      name: "reply_to_user",
      input: { message: wording === "identical" ? CONSISTENT_DECLINE : REWORDED_DECLINES[(trial - 1) % REWORDED_DECLINES.length]! },
    },
  ]);
}

const CONSISTENT_DECLINE = "Order #1234 was already refunded ($42.00 on 2026-09-12), so I haven't issued a second refund.";
const REWORDED_DECLINES = [
  "Order #1234 was already refunded ($42.00 on 2026-09-12), so I haven't issued a second refund.",
  "It looks like order 1234 already received a full refund of $42.00 on September 12, so no new refund was made.",
  "No refund issued: #1234 was refunded in full ($42.00) on 2026-09-12 already.",
  "I checked order 1234 and it was already refunded on Sept 12 for $42.00, so I didn't refund it again.",
  "That order (#1234) already got its $42.00 refund on 2026-09-12. I haven't processed another one.",
];

/**
 * Write the synthetic batch into `store`: task and v1 synced from the real
 * tasks/refund-duplicate-check.yaml, five trials of v1 through the real proxy, sandboxing
 * process_refund per the real spec. `toyEnv` is passed to the toy tool server (e.g. its
 * side-effect log, to prove no refund reached the backend).
 */
export async function writePrincetonBatch(
  store: TraceStore,
  task: LoadedTask,
  toyEnv: Record<string, string> = {}
): Promise<BatchSummary> {
  return writeScriptedBatch(store, task, princetonScript(), PRINCETON_TRIALS, toyEnv);
}

/** Like writePrincetonBatch, with any scripted agent: `trials` trials of v1, sequentially. */
export async function writeScriptedBatch(
  store: TraceStore,
  task: LoadedTask,
  callModel: (options: CallMessagesOptions) => Promise<MessagesResponse>,
  trials: number,
  toyEnv: Record<string, string> = {}
): Promise<BatchSummary> {
  const v1 = task.fixture!.variants.find((v) => v.id === "v1")!;
  const { taskId, variantIds } = syncTask(store, task, [v1]);
  return runBatch(
    {
      task_id: taskId,
      task_name: task.spec.name,
      tier: "smoke",
      variants: [{ variant_id: variantIds.get("v1")!, variant_label: "v1", prompt_text: v1.text }],
      variants_requested: 1,
      trials,
      trial: {
        dangerous_tools: task.spec.tools.dangerous,
        upstream: { command: process.execPath, args: [require_.resolve("@invariant/toy-tool-server/bin")], env: toyEnv },
        max_wall_clock_seconds: task.spec.execution.max_wall_clock_seconds,
      },
      concurrency: 1,
      retry: { max_attempts: 1, retry_on: [] },
    },
    { store, callModel }
  );
}
