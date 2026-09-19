import fs from "node:fs";
import { TaskSpecSchema } from "../schema/task-spec.js";
import { VariantFixtureSchema, type VariantFixture } from "../schema/variant-fixture.js";
import { parse as parseYaml } from "yaml";
import { taskSpecPath, variantFixturePath } from "../lib/paths.js";

interface RegenOptions {
  task: string;
  count: number;
  approve: boolean;
  approvedBy: string;
}

async function generateParaphrasings(promptTemplate: string, count: number): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Variant generation calls an LLM to paraphrase the " +
        "task prompt and needs a real key, there is no offline fallback because a fake " +
        "paraphraser would defeat the point of this command. Set the key and re-run, " +
        "or write the fixture file by hand (see internal-docs/TECHNICAL_SPEC.md section 2)."
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content:
            `Rewrite the following instruction ${count} different ways. Each rewrite must ` +
            `preserve the exact same intent and every factual detail, changing only phrasing, ` +
            `tone, or sentence structure. This is for testing whether an AI agent behaves ` +
            `consistently across equivalent phrasings, so the rewrites must stay genuinely ` +
            `equivalent, not introduce new ambiguity or remove existing ambiguity.\n\n` +
            `Instruction:\n${promptTemplate}\n\n` +
            `Respond with ONLY a JSON array of ${count} strings, nothing else.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((b) => b.type === "text")?.text ?? "[]";
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Model response was not a JSON array of strings.");
  }
  return parsed;
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

  const rewrites = await generateParaphrasings(spec.prompt_template, opts.count);

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
