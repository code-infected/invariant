import fs from "node:fs";
import path from "node:path";
import { TASKS_DIR } from "../lib/paths.js";

const EXAMPLE_CONFIG = `providers:
  retry:
    max_attempts: 3
    retry_on: [429, 503, "timeout"]
execution:
  worker_concurrency: 8
  default_tier: smoke
judge:
  temperature: 0
  votes: 3
  embedding_prefilter_threshold_high: 0.95
  embedding_prefilter_threshold_low: 0.40
`;

export function runInit(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const configPath = path.join(path.dirname(TASKS_DIR), "invariant.config.yaml");
  if (fs.existsSync(configPath)) {
    console.log(`invariant.config.yaml already exists, leaving it alone.`);
  } else {
    fs.writeFileSync(configPath, EXAMPLE_CONFIG, "utf8");
    console.log(`Wrote ${path.relative(process.cwd(), configPath)}`);
  }

  console.log(`tasks/ is ready. Add a task with a <name>.yaml spec and a matching`);
  console.log(`<name>.variants.json fixture, then run: invariant validate`);
}
