import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { TaskSpecSchema, type TaskSpec } from "../schema/task-spec.js";
import { VariantFixtureSchema, type VariantFixture } from "../schema/variant-fixture.js";
import { TASKS_DIR, taskSpecPath, variantFixturePath } from "./paths.js";

export interface LoadedTask {
  name: string;
  spec: TaskSpec;
  fixture: VariantFixture | null;
  errors: string[];
}

function listTaskNames(): string[] {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.basename(f, ".yaml"))
    .sort();
}

export function loadTask(name: string): LoadedTask {
  const errors: string[] = [];
  let spec: TaskSpec | undefined;
  let fixture: VariantFixture | null = null;

  const specFile = taskSpecPath(name);
  if (!fs.existsSync(specFile)) {
    errors.push(`no task spec found at tasks/${name}.yaml`);
  } else {
    const raw = parseYaml(fs.readFileSync(specFile, "utf8"));
    const result = TaskSpecSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`spec: ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      spec = result.data;
      if (spec.name !== name) {
        errors.push(
          `spec.name ("${spec.name}") does not match its filename (tasks/${name}.yaml)`
        );
      }
    }
  }

  const fixtureFile = variantFixturePath(name);
  if (!fs.existsSync(fixtureFile)) {
    errors.push(`no variant fixture found at tasks/${name}.variants.json (run: invariant variants regen --task=${name})`);
  } else {
    const raw = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    const result = VariantFixtureSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`fixture: ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      fixture = result.data;
      if (fixture.task !== name) {
        errors.push(
          `fixture.task ("${fixture.task}") does not match its filename (tasks/${name}.variants.json)`
        );
      }
    }
  }

  if (spec && spec.thresholds.state_mutation_consistency < 1.0) {
    errors.push(
      `warning: thresholds.state_mutation_consistency is ${spec.thresholds.state_mutation_consistency}, below 1.0. ` +
        `This axis maps directly to real-world harm (see ARCHITECTURE.md section 4); relaxing it should be a deliberate, documented choice, not a default.`
    );
  }

  if (spec && fixture) {
    for (const tier of ["smoke", "full"] as const) {
      const wanted = tier === "smoke" ? spec.execution.variants_smoke : spec.execution.variants_full;
      if (fixture.variants.length < wanted) {
        errors.push(
          `warning: execution.variants_${tier} is ${wanted} but the fixture has ${fixture.variants.length} variant(s); ` +
            `the ${tier} tier will run all ${fixture.variants.length} rather than repeat phrasings to pad the count.`
        );
      }
    }
  }

  return { name, spec: spec as TaskSpec, fixture, errors };
}

export function loadAllTasks(): LoadedTask[] {
  return listTaskNames().map(loadTask);
}

/** Load a task and refuse to go further if it does not validate (warnings are fine). */
export function loadValidTask(name: string): LoadedTask {
  const task = loadTask(name);
  const hardErrors = task.errors.filter((e) => !e.startsWith("warning:"));
  if (hardErrors.length > 0) {
    throw new Error(
      `task "${name}" is not valid, refusing to use it:\n` + hardErrors.map((e) => `  - ${e}`).join("\n")
    );
  }
  return task;
}
