#!/usr/bin/env node
import { Command } from "commander";
import { runValidate } from "./commands/validate.js";
import { runInit } from "./commands/init.js";
import { runVariantsRegen } from "./commands/variants-regen.js";

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
