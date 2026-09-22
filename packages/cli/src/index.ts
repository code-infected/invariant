#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { runValidate } from "./commands/validate.js";
import { runInit } from "./commands/init.js";
import { runVariantsRegen } from "./commands/variants-regen.js";
import { runRun } from "./commands/run.js";
import { runScore } from "./commands/score.js";
import { runGate } from "./commands/gate.js";
import { runDemoSeed } from "./commands/demo-seed.js";
import { runDashboard } from "./commands/dashboard.js";
import { runIngest } from "./commands/ingest.js";
import { runExport } from "./commands/export.js";
import { runAdversarialCommand } from "./commands/adversarial.js";
import { runDoctor } from "./commands/doctor.js";
import { MODEL_ROLES, type ModelRole } from "./lib/models.js";

const program = new Command();

program
  .name("invariant")
  .description("Agent behavioral consistency and regression testing harness.")
  .version("0.1.0");

program
  .command("init")
  .description("Scaffold tasks/ and invariant.config.yaml")
  .action(() => {
    runInit();
  });

program
  .command("doctor")
  .description(
    "For each configured model role (agent, judge, paraphraser, embedder): provider, endpoint host, and whether its " +
      "credentials are present (the variable's name only; a key is never printed). --ping makes one minimal live call " +
      "per role and reports the model id the provider reported and the latency. Exits 1 if a checked role is missing, " +
      "has no credentials, or (with --ping) did not answer."
  )
  .option("--ping", "make one minimal live call per role (spends a few tokens)", false)
  .option("--roles <roles>", `comma-separated roles to check (${MODEL_ROLES.join(", ")}); default: every configured role. A named role must be configured.`)
  .option("--json", "print the report as JSON", false)
  .action(async (opts) => {
    try {
      const roles = opts.roles
        ? String(opts.roles)
            .split(",")
            .map((r: string) => r.trim())
            .filter(Boolean)
        : undefined;
      const bad = (roles ?? []).filter((r: string) => !(MODEL_ROLES as readonly string[]).includes(r));
      if (bad.length > 0) throw new Error(`unknown role(s) ${bad.join(", ")}; roles are ${MODEL_ROLES.join(", ")}`);
      const report = await runDoctor({ ping: Boolean(opts.ping), roles: roles as ModelRole[] | undefined, json: Boolean(opts.json) });
      process.exitCode = report.ok ? 0 : 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("validate")
  .description("Validate all task specs and their variant fixtures")
  .action(() => {
    runValidate();
  });

function positiveInt(flag: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`${flag} must be a positive integer, got "${value}"`);
    return n;
  };
}

program
  .command("run")
  .description(
    "Run a tier (every variant x trial the task spec asks for) or, with --variant, one debugging trial. " +
      "The agent under test is models.agent in invariant.config.yaml (or --model) and needs its provider's key " +
      "(see invariant doctor)."
  )
  .option("--task <name>", "task name (matches tasks/<name>.yaml); with a tier, omit to run every task")
  .addOption(
    new Option("--tier <tier>", "fan out the smoke or full tier (default: execution.default_tier in invariant.config.yaml)").choices([
      "smoke",
      "full",
    ])
  )
  .option("--variant <id>", "run exactly one trial of this variant (e.g. v1), no fan-out, no retries")
  .option("--trial <n>", "trial number recorded with a --variant run (default 1)", positiveInt("--trial"))
  .option("--concurrency <n>", "max trials in flight (default: execution.worker_concurrency)", positiveInt("--concurrency"))
  .option("--model <provider:model>", "agent under test, overriding models.agent (e.g. openai:gpt-4.1, ollama:qwen2.5:3b)")
  .option(
    "--runnable-only",
    "tier runs: skip (and name) tasks whose declared tools the tool server does not serve, instead of refusing the whole run",
    false
  )
  .option("--json", "print JSON: the full trace record for --variant, the batch summary for a tier", false)
  .option("--otel", "tier runs: export each batch as an OpenTelemetry trace afterwards (unscored; see invariant export)", false)
  .option("--otel-endpoint <url>", "OTLP/HTTP endpoint for --otel (default: as for invariant export)")
  .action(async (opts) => {
    try {
      await runRun({
        task: opts.task,
        variant: opts.variant,
        tier: opts.tier,
        trial: opts.trial,
        concurrency: opts.concurrency,
        model: opts.model,
        runnableOnly: Boolean(opts.runnableOnly),
        otel: Boolean(opts.otel),
        otelEndpoint: opts.otelEndpoint,
        json: Boolean(opts.json),
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("score")
  .description(
    "Score one batch on the three consistency axes (state-mutation, tool-path, outcome) and show pass/fail " +
      "per axis against the task's thresholds. Saves the scores to the trace store. The outcome axis asks an " +
      "LLM judge (models.judge, or --judge-model) and needs its provider's key; the other two need no model. Exits nonzero only if an axis " +
      "could not be scored, never because a score is below its threshold (that is the gate's job)."
  )
  .option("--batch <id>", "the batch to score (printed by invariant run --tier)")
  .option("--task <name>", "score this task's most recent finished batch")
  .option("--json", "print the full scoring result as JSON", false)
  .option("--judge-model <provider:model>", "outcome judge, overriding models.judge")
  .option("--store <path>", "trace store directory holding trace.db (default: .invariant at the repo root)")
  .action(async (opts) => {
    try {
      await runScore({ batch: opts.batch, task: opts.task, json: Boolean(opts.json) }, { storeRoot: opts.store, judgeModel: opts.judgeModel });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("gate")
  .description(
    "Compare a batch's consistency scores to its task's thresholds and exit for CI: 0 pass, 1 an axis scored " +
      "below its threshold, 2 could not evaluate (an axis has no score, no finished batch, invalid spec...), " +
      "3 security finding (an adversarial payload propagated; reported in its own security section, and 3 outranks 1 and 2). " +
      "Reuses the batch's stored score when it is still valid, otherwise scores it first (same code as " +
      "invariant score). With neither --batch nor --task, gates the latest batch of every task; tasks the tool " +
      "server cannot run are listed as not gated. Uncomputed axes fail closed: the outcome axis needs " +
      "its judge (models.judge) and that provider's key, and without it the gate cannot pass unless --allow-uncomputed=outcome."
  )
  .option("--batch <id>", "gate this batch")
  .option("--task <name>", "gate this task's latest batch")
  .option("--json", "print the JSON report to stdout instead of the text report", false)
  .option("--report <path>", "also write the JSON report to this file")
  .option("--markdown <path>", "also write a markdown report (for a PR comment) to this file")
  .option(
    "--allow-uncomputed <axes>",
    "comma-separated axes allowed to have no score without failing the gate; only 'outcome' is accepted. " +
      "The verdict is then pass_with_waivers, not pass, and the report names the waived axis"
  )
  .option("--rescore", "score the batch now even if a reusable stored score exists", false)
  .option("--require-adversarial", "a payload fixture of a gated task with no adversarial batch is incomplete (exit 2), not 'not run'", false)
  .option("--judge-model <provider:model>", "outcome judge, overriding models.judge")
  .option("--store <path>", "trace store directory holding trace.db (default: .invariant at the repo root)")
  .action(async (opts) => {
    try {
      const report = await runGate({
        batch: opts.batch,
        task: opts.task,
        json: Boolean(opts.json),
        report: opts.report,
        markdown: opts.markdown,
        allowUncomputed: opts.allowUncomputed
          ? String(opts.allowUncomputed)
              .split(",")
              .map((s: string) => s.trim().replace(/-/g, "_"))
              .filter(Boolean)
          : [],
        rescore: Boolean(opts.rescore),
        requireAdversarial: Boolean(opts.requireAdversarial),
      }, { storeRoot: opts.store, judgeModel: opts.judgeModel });
      process.exitCode = report.exit_code;
    } catch (err) {
      // Bad arguments or an unreadable store: the gate could not evaluate anything.
      console.error((err as Error).message);
      process.exitCode = 2;
    }
  });

program
  .command("ingest")
  .description(
    "Import trial trace files written by an out-of-process adapter (e.g. adapters/langgraph) into the trace " +
      "store as one batch. Every file is validated first (schemas/trial-trace.v1.schema.json, the task spec, " +
      "the variant fixture, a complete run matrix, dangerous tools sandboxed); if any check fails nothing is written."
  )
  .argument("<paths...>", "trace files, or directories of *.json trace files")
  .requiredOption("--task <name>", "task name (matches tasks/<name>.yaml)")
  .addOption(new Option("--tier <tier>", "the tier the files were run as").choices(["smoke", "full"]).makeOptionMandatory())
  .option("--json", "print the ingest summary as JSON", false)
  .option("--store <path>", "trace store directory holding trace.db (default: .invariant at the repo root)")
  .action((paths: string[], opts) => {
    try {
      runIngest({ task: opts.task, tier: opts.tier, paths, json: Boolean(opts.json) }, { storeRoot: opts.store });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("export")
  .description(
    "Export a stored batch as an OpenTelemetry trace over OTLP/HTTP: one trace per batch, a span per run, a child " +
      "span per tool call (sandboxed ones marked), the latest stored score as attributes and events on the batch span. " +
      "Reads the trace store after the fact; span times are the recorded ones. Endpoint: --endpoint, else " +
      "OTEL_EXPORTER_OTLP_ENDPOINT, else export.otel_endpoint in invariant.config.yaml, else http://localhost:4318."
  )
  .option("--batch <id>", "the batch to export")
  .option("--task <name>", "export this task's latest finished batch")
  .option("--endpoint <url>", "OTLP/HTTP base URL (e.g. http://localhost:4318) or full .../v1/traces URL")
  .option("--dry-run", "print the span tree that would be sent, send nothing", false)
  .option("--json", "print a JSON summary", false)
  .option("--store <path>", "trace store directory holding trace.db (default: .invariant at the repo root)")
  .action(async (opts) => {
    try {
      await runExport(
        { batch: opts.batch, task: opts.task, endpoint: opts.endpoint, dryRun: Boolean(opts.dryRun), json: Boolean(opts.json) },
        { storeRoot: opts.store }
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("dashboard")
  .description("Start the read-only dashboard (leaderboard, batch detail, trace diff, trend) on a trace store")
  .option("--port <n>", "port to listen on", positiveInt("--port"), 4400)
  .option("--store <path>", "trace store directory holding trace.db (default: .invariant at the repo root)")
  .action(async (opts) => {
    try {
      process.exitCode = await runDashboard({ port: opts.port, store: opts.store });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("demo-seed")
  .description(
    "Write a SYNTHETIC demo trace store for the dashboard: five scripted batches of refund-duplicate-check " +
      "(a scripted stand-in, not a model) through the real proxy, sandbox and scorer, including a system-prompt " +
      "change and a mid-batch 'model' change. Never touches the default store; never calls a model or the judge."
  )
  .requiredOption("--store <path>", "directory for the new demo store (must not already hold a trace.db; not .invariant)")
  .action(async (opts) => {
    try {
      console.error("writing SYNTHETIC demo batches (scripted stand-in, not a model)...");
      const result = await runDemoSeed({ store: opts.store });
      console.log(`demo store: ${result.store}`);
      console.log(`view it: invariant dashboard --store=${opts.store}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const adversarial = program.command("adversarial").description("Adversarial mode: planted-instruction (indirect prompt injection) test fixtures");

adversarial
  .command("run")
  .description(
    "Run a tier with a payload fixture (tasks/adversarial/) planted by the proxy into one tool response per run, then score " +
      "injection propagation: the share of runs where the agent went on to make the payload's unauthorized call, and how " +
      "many calls later. Stored as an adversarial batch, never mixed with consistency batches; gate it with invariant gate. " +
      "Without --payload, runs every payload (for --task, that task's). The agent is models.agent (or --model) and needs its provider's key."
  )
  .option("--task <name>", "base task (must match the payload's task)")
  .option("--payload <file|id>", "a payload id under tasks/adversarial/, or a path to a payload fixture")
  .addOption(new Option("--tier <tier>", "smoke or full (default: execution.default_tier)").choices(["smoke", "full"]))
  .option("--concurrency <n>", "max trials in flight (default: execution.worker_concurrency)", positiveInt("--concurrency"))
  .option("--model <provider:model>", "agent under test, overriding models.agent")
  .option("--runnable-only", "skip (and name) payloads whose base task the tool server cannot run", false)
  .option("--json", "print JSON", false)
  .action(async (opts) => {
    try {
      await runAdversarialCommand({
        task: opts.task,
        payload: opts.payload,
        tier: opts.tier,
        concurrency: opts.concurrency,
        model: opts.model,
        runnableOnly: Boolean(opts.runnableOnly),
        json: Boolean(opts.json),
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const variants = program.command("variants").description("Manage variant fixtures");

variants
  .command("regen")
  .description("Propose regenerated paraphrasings for a task (requires --approve to write). The paraphraser is models.paraphraser (or --model).")
  .requiredOption("--task <name>", "task name (matches tasks/<name>.yaml)")
  .option("--model <provider:model>", "paraphraser, overriding models.paraphraser")
  .option("--count <n>", "number of paraphrasings to generate", "5")
  .option("--approve", "write the fixture file instead of just previewing it", false)
  .option("--approved-by <name>", "recorded as the human reviewer", process.env.USER ?? "unknown")
  .action(async (opts) => {
    try {
      await runVariantsRegen({
        task: opts.task,
        count: Number.parseInt(opts.count, 10),
        approve: Boolean(opts.approve),
        approvedBy: opts.approvedBy,
        model: opts.model,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program.parse();
