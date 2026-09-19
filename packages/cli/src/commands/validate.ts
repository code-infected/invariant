import { loadAllTasks } from "../lib/load-tasks.js";

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

  console.log("");
  console.log(`${tasks.length} task(s) checked, ${hardFailures} error(s).`);

  if (hardFailures > 0) {
    process.exitCode = 1;
  }
}
