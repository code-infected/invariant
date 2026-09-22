/**
 * Regenerate schemas/trial-trace.v1.schema.json from the Zod schema:
 *   npm run schema:trial-trace -w @invariant/cli
 * The trial-trace test fails when the checked-in file is stale.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../lib/paths.js";
import { TRIAL_TRACE_SCHEMA_FILE, trialTraceJsonSchema } from "./trial-trace-json-schema.js";

const target = path.join(REPO_ROOT, TRIAL_TRACE_SCHEMA_FILE);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, trialTraceJsonSchema(), "utf8");
console.log(`wrote ${TRIAL_TRACE_SCHEMA_FILE}`);
