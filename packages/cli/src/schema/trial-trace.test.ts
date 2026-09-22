import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../lib/paths.js";
import { TRIAL_TRACE_SCHEMA_FILE, trialTraceJsonSchema } from "./trial-trace-json-schema.js";

test("the checked-in trial trace JSON Schema is generated from the Zod schema, not edited by hand", () => {
  const checkedIn = fs.readFileSync(path.join(REPO_ROOT, TRIAL_TRACE_SCHEMA_FILE), "utf8");
  assert.equal(
    checkedIn,
    trialTraceJsonSchema(),
    `${TRIAL_TRACE_SCHEMA_FILE} is stale; regenerate it with: npm run schema:trial-trace -w @invariant/cli`
  );
});
