#!/usr/bin/env node
import { Command } from "commander";
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

program
  .command("run")
  .description("Run a single trial of one task variant through the MCP proxy (requires ANTHROPIC_API_KEY)")
  .requiredOption("--task <name>", "task name (matches tasks/<name>.yaml)")
  .requiredOption("--variant <id>", "variant id from tasks/<name>.variants.json, e.g. v1")
  .option("--trial <n>", "trial number recorded with the run", "1")
  .option("--model <id>", "model to drive the agent under test")
  .option("--json", "print the full trace record as JSON", false)
  .action(async (opts) => {
    try {
      await runRun({
        task: opts.task,
        variant: opts.variant,
        trial: Number.parseInt(opts.trial, 10),
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
