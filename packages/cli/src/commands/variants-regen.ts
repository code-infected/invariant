import fs from "node:fs";
import { TaskSpecSchema } from "../schema/task-spec.js";
import { VariantFixtureSchema, type VariantFixture } from "../schema/variant-fixture.js";
import { parse as parseYaml } from "yaml";
import { taskSpecPath, variantFixturePath } from "../lib/paths.js";
import { clientFor, type ModelClient, type ModelParams } from "@invariant/providers";
import { loadConfig } from "../lib/config.js";
import { requireCredentials, requireRole, roleMissingKeyMessage } from "../lib/models.js";

interface RegenOptions {
  task: string;
  count: number;
  approve: boolean;
  approvedBy: string;
  /** --model=provider:model: overrides models.paraphraser. */
  model?: string;
}

/** Room for a JSON array of paraphrasings; required by the Anthropic protocol, sent to every provider for the same reason. */
const PARAPHRASER_MAX_TOKENS = 1024;

export function paraphrasePrompt(promptTemplate: string, count: number): string {
  return (
    `Rewrite the following instruction ${count} different ways. Each rewrite must ` +
    `preserve the exact same intent and every factual detail, changing only phrasing, ` +
    `tone, or sentence structure. This is for testing whether an AI agent behaves ` +
    `consistently across equivalent phrasings, so the rewrites must stay genuinely ` +
    `equivalent, not introduce new ambiguity or remove existing ambiguity.\n\n` +
    `Instruction:\n${promptTemplate}\n\n` +
    `Respond with ONLY a JSON array of ${count} strings, nothing else.`
  );
}

/** The model's reply as a JSON array of strings; tolerates a ```json fence around it, nothing else. */
export function parseParaphrasings(text: string): string[] {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error(`Model response was not valid JSON: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    throw new Error("Model response was not a JSON array of strings.");
  }
  return parsed as string[];
}

export async function generateParaphrasings(client: ModelClient, promptTemplate: string, count: number, params: ModelParams = {}): Promise<string[]> {
  const res = await client.chat({
    system: "",
    messages: [{ role: "user", content: paraphrasePrompt(promptTemplate, count) }],
    tools: [],
    params: { max_tokens: PARAPHRASER_MAX_TOKENS, ...params },
  });
  return parseParaphrasings(res.text);
}

export async function runVariantsRegen(opts: RegenOptions): Promise<void> {
  const specFile = taskSpecPath(opts.task);
  if (!fs.existsSync(specFile)) {
    throw new Error(`no task spec at tasks/${opts.task}.yaml`);
  }
  const spec = TaskSpecSchema.parse(parseYaml(fs.readFileSync(specFile, "utf8")));

  const fixtureFile = variantFixturePath(opts.task);
  let existing: VariantFixture | null = null;
  if (fs.existsSync(fixtureFile)) {
    existing = VariantFixtureSchema.parse(JSON.parse(fs.readFileSync(fixtureFile, "utf8")));
  }

  const paraphraser = requireRole(loadConfig(), "paraphraser", opts.model);
  requireCredentials("paraphraser", paraphraser);
  const client = clientFor(paraphraser, { missing: (s) => roleMissingKeyMessage("paraphraser", s) });
  console.log(`Paraphraser: ${paraphraser.model}`);
  // Params from the config go last so an explicit models.paraphraser.params.max_tokens wins.
  const rewrites = await generateParaphrasings(client, spec.prompt_template, opts.count, paraphraser.params ?? {});

  const next: VariantFixture = {
    task: opts.task,
    fixture_version: (existing?.fixture_version ?? 0) + 1,
    generated_at: new Date().toISOString(),
    approved_by: opts.approvedBy,
    variants: rewrites.map((text, i) => ({ id: `v${i + 1}`, text })),
  };

  console.log(`Proposed variant fixture for "${opts.task}" (version ${next.fixture_version}):`);
  console.log("");
  if (existing) {
    console.log("--- current ---");
    for (const v of existing.variants) console.log(`  [${v.id}] ${v.text}`);
    console.log("");
  }
  console.log("--- proposed ---");
  for (const v of next.variants) console.log(`  [${v.id}] ${v.text}`);
  console.log("");

  if (!opts.approve) {
    console.log(
      "Not written. Review the proposed variants above, then re-run with --approve to " +
        "commit them to tasks/" + opts.task + ".variants.json"
    );
    return;
  }

  fs.writeFileSync(fixtureFile, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`Wrote tasks/${opts.task}.variants.json (version ${next.fixture_version}).`);
}
