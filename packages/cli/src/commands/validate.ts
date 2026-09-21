import fs from "node:fs";
import { parseConfig } from "../lib/config.js";
import { loadAllTasks } from "../lib/load-tasks.js";
import { CONFIG_PATH } from "../lib/paths.js";

export function runValidate(): void {
  const tasks = loadAllTasks();

  if (tasks.length === 0) {
    console.log("No task specs found under tasks/. Nothing to validate.");
    return;
  }

  let hardFailures = 0;

  for (const task of tasks) {
    const hard = task.errors.filter((e) => !e.startsWith("warning:"));
    const warnings = task.errors.filter((e) => e.startsWith("warning:"));

    if (hard.length === 0) {
      console.log(`OK    ${task.name}`);
    } else {
      console.log(`FAIL  ${task.name}`);
      hardFailures += hard.length;
    }
    for (const e of hard) console.log(`        - ${e}`);
    for (const w of warnings) console.log(`        - ${w}`);
  }

  // The config is only required by tier runs, so a missing file is a note, not a failure;
  // a present-but-invalid one is a failure, since `invariant run --tier` would refuse it.
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`note  invariant.config.yaml not found (needed for tier runs; run: invariant init)`);
  } else {
    const config = parseConfig(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (config.ok) {
      console.log(`OK    invariant.config.yaml`);
    } else {
      console.log(`FAIL  invariant.config.yaml`);
      for (const e of config.errors) console.log(`        - ${e}`);
      hardFailures += config.errors.length;
    }
  }

  console.log("");
  console.log(`${tasks.length} task(s) checked, ${hardFailures} error(s).`);

  if (hardFailures > 0) {
    process.exitCode = 1;
  }
}
