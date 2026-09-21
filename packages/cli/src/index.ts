#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { runValidate } from "./commands/validate.js";
import { runInit } from "./commands/init.js";
import { runVariantsRegen } from "./commands/variants-regen.js";
import { runRun } from "./commands/run.js";

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
      "Requires ANTHROPIC_API_KEY."
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
  .option("--model <id>", "model to drive the agent under test")
  .option("--json", "print JSON: the full trace record for --variant, the batch summary for a tier", false)
  .action(async (opts) => {
    try {
      await runRun({
        task: opts.task,
        variant: opts.variant,
        tier: opts.tier,
        trial: opts.trial,
        concurrency: opts.concurrency,
        model: opts.model,
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
  .description("Propose regenerated paraphrasings for a task (requires --approve to write)")
  .requiredOption("--task <name>", "task name (matches tasks/<name>.yaml)")
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
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program.parse();
